const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lung2024';
const FALLBACK_PASSWORDS = [ADMIN_PASSWORD, 'lung2024', 'cardiac2024'];

// ネットワークIPアドレス取得
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

let publicUrl = process.env.PUBLIC_URL || null;

let globalNetworkInfo = {
  ips: getLocalIpAddresses(),
  primaryIp: getLocalIpAddresses()[0] || 'localhost',
  studentUrl: publicUrl || `http://${getLocalIpAddresses()[0] || 'localhost'}:${PORT}/`,
  isPublic: !!publicUrl,
  qrCodeDataUrl: null
};

async function initNetworkInfo() {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  const studentUrl = publicUrl || `http://${primaryIp}:${PORT}/`;
  try {
    const qr = await QRCode.toDataURL(studentUrl, {
      margin: 2,
      width: 256,
      color: { dark: '#1a365d', light: '#ffffff' }
    });
    globalNetworkInfo = { ips, primaryIp, studentUrl, isPublic: !!publicUrl, qrCodeDataUrl: qr };
  } catch (e) {
    console.error('QR code generation error:', e);
  }
}
initNetworkInfo();

// シナリオデータのロード
const scenarioPath = path.join(__dirname, 'data', 'scenario.json');
let scenarioData;
try {
  scenarioData = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
} catch (err) {
  console.error('Failed to load scenario.json:', err);
  process.exit(1);
}

// サーバーインメモリ状態
let sceneStatuses = {
  1: 'ACTIVE',
  2: 'LOCKED',
  3: 'LOCKED',
  4: 'LOCKED'
};

const groups = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- ヘルパー関数 ---

function getSceneBudget(sceneId) {
  const sid = String(sceneId);
  return scenarioData.scenes[sid]?.budget || 3;
}

function createGroupState(groupId, groupName) {
  return {
    groupId,
    groupName,
    currentScene: 1,
    registeredAt: new Date().toISOString(),
    scenes: {
      1: createSceneState(1),
      2: createSceneState(2),
      3: createSceneState(3),
      4: createSceneState(4)
    }
  };
}

function createSceneState(sceneId) {
  const budget = getSceneBudget(sceneId);
  return {
    sceneId,
    phase: 'assessment', // 'assessment' | 'submitted' | 'result' | 'resolved'
    selectedInfo: [],
    budget: budget,
    remainingBudget: budget,
    decision: null,
    rationaleText: '',
    highlightedInDebrief: false,
    submittedAt: null,
    result: null
  };
}

// 自由記述アセスメント（rationaleText）の4水準ルーブリック評価
function evaluateRationaleText(sceneId, rationaleText) {
  const sid = String(sceneId);
  const text = (rationaleText || '').trim();

  if (!text) {
    return {
      level: '未記述',
      levelCode: 'NONE',
      matchedElements: [],
      missingHints: ['自由記述が入力されていません。'],
      feedback: '判断の根拠となる患者情報と病態生理を自分の言葉で記述してみましょう。'
    };
  }

  const hasAny = (keywords) => keywords.some(k => text.includes(k));

  if (sid === '1') {
    const e1 = hasAny(['喫煙', 'たばこ', 'タバコ', '白色痰', '痰', '息切れ', '64%', 'FEV', '気流閉塞', '閉塞性', '68歳', '加齢']);
    const e2 = hasAny(['全身麻酔', '分離肺換気', '片肺', '左上葉切除', '肺切除', '肺容量', '再拡張']);
    const e3 = hasAny(['疼痛', '痛み', '創痛', '深呼吸', '咳嗽', '咳', '抑制']);
    const e4 = hasAny(['無気肺', '分泌物', '貯留', '換気低下', '低酸素', '合併症', '肺炎']);

    const matched = [];
    const missing = [];
    if (e1) matched.push('患者背景（喫煙・喀痰・気流閉塞傾向）'); else missing.push('長期喫煙・白色痰・FEV₁/FVC 64%などの術前背景');
    if (e2) matched.push('手術・麻酔要因（全身麻酔・分離肺換気・肺切除）'); else missing.push('全身麻酔・分離肺換気・左上葉切除による肺容量や再拡張への影響');
    if (e3) matched.push('術後疼痛による深呼吸・咳嗽抑制'); else missing.push('術後疼痛によって深呼吸や有効な咳嗽が抑制される視点');
    if (e4) matched.push('予測される術後リスク（分泌物貯留・無気肺等）'); else missing.push('分泌物貯留・肺胞換気低下・無気肺・低酸素血症などの具体的リスク');

    const count = [e1, e2, e3, e4].filter(Boolean).length;
    let level = '知識の再生';
    let levelCode = 'LEVEL_1';
    if (count === 4 || (e1 && e3 && e4 && e2)) {
      level = '臨床推論（高度な統合）';
      levelCode = 'LEVEL_4';
    } else if (e3 && (e1 || e2)) {
      level = '情報の統合（病態生理の関連づけ）';
      levelCode = 'LEVEL_3';
    } else if (e2 || (e1 && count >= 2)) {
      level = '情報の解釈（根拠の提示）';
      levelCode = 'LEVEL_2';
    }

    let feedback = `【記述評価：${level}】確認できた視点：${matched.join('、') || '基本的なリスク意識'}。`;
    if (missing.length > 0) {
      feedback += `\nさらに「${missing.join('」「')}」を関連づけると、患者背景と手術侵襲の相互作用がより明確に説明できます。`;
    } else {
      feedback += `\n安静時SpO₂ 97%という現在の安定と術後リスクを明確に区別し、患者背景・手術麻酔・術後疼痛の相互作用から術後合併症を高い水準で予測できています。`;
    }
    return { level, levelCode, matchedElements: matched, missingHints: missing, feedback };
  }

  if (sid === '2') {
    const e1 = hasAny(['97', '93', 'SpO2', 'SpO₂', '酸素化', '低下', '悪化', '夕方', '比較']);
    const e2 = hasAny(['呼吸数', '18', '24', '頻呼吸', '脈拍', '86', '98', '代償', '疼痛', '痛み', 'NRS']);
    const e3 = hasAny(['無気肺', '分泌物', '痰', '換気', '気胸', 'エアリーク', '出血', '虚脱']);
    const e4 = hasAny(['呼吸音', '聴診', '胸郭', 'ドレーン', 'X線', 'レントゲン', '重症度', '確認']);

    const matched = [];
    const missing = [];
    if (e1) matched.push('時間的変化からの酸素化悪化の判断'); else missing.push('術当日夕方と比べた同酸素条件下でのSpO₂低下（97%→93%）＝酸素化悪化の明示');
    if (e2) matched.push('頻呼吸・脈拍増加・疼痛増強の意味づけ'); else missing.push('呼吸数増加（18→24回/分）や疼痛増強（NRS 5→7）の代償反応・呼吸様式への意味づけ');
    if (e3) matched.push('原因に関する病態仮説（換気低下・分泌物・無気肺・気胸等）'); else missing.push('酸素化が悪化した原因の仮説（分泌物貯留・無気肺・気胸など）');
    if (e4) matched.push('仮説を検証するための情報収集の目的'); else missing.push('なぜその観察項目（呼吸音・胸郭・ドレーン・X線等）を確認するのかという目的');

    const count = [e1, e2, e3, e4].filter(Boolean).length;
    let level = '知識の再生';
    let levelCode = 'LEVEL_1';
    if (count === 4 || (e1 && e3 && e4 && e2)) {
      level = '臨床推論（高度な統合）';
      levelCode = 'LEVEL_4';
    } else if (e3 && (e1 || e2)) {
      level = '情報の統合（病態生理の関連づけ）';
      levelCode = 'LEVEL_3';
    } else if (e2 || (e1 && count >= 2)) {
      level = '情報の解釈（根拠の提示）';
      levelCode = 'LEVEL_2';
    }

    let feedback = `【記述評価：${level}】確認できた視点：${matched.join('、') || '状態変化への着目'}。`;
    if (missing.length > 0) {
      feedback += `\nさらに「${missing.join('」「')}」を加えると、仮説検証型の情報収集としてさらに説得力が高まります。`;
    } else {
      feedback += `\n夕方からの時間的変化を正確に捉えて酸素化の悪化を判断し、仮説を確かめるための情報収集の目的まで論理的に説明できています。`;
    }
    return { level, levelCode, matchedElements: matched, missingHints: missing, feedback };
  }

  if (sid === '3') {
    // Scene 3（最重要）：4要素チェック
    // 1. 現在、酸素化が悪化しているという判断
    const e1 = hasAny(['酸素化', '低酸素', 'SpO2', 'SpO₂', '93', '悪化', '低下', '下がっ']);
    // 2. その根拠となる患者情報（呼吸音・X線・呼吸数等の客観的所見）
    const e2 = hasAny(['呼吸音', '減弱', '弱く', '副雑音', '胸郭', '24', '頻呼吸', 'X線', 'レントゲン']);
    // 3. 無気肺・換気低下を引き起こす病態生理・関与要因（疼痛・浅呼吸・喀痰困難・喫煙・麻酔・肺切除など）
    const e3 = hasAny(['疼痛', '痛み', 'NRS', '浅い呼吸', '浅呼吸', '喀痰困難', '痰が出', '喫煙', '気流閉塞', '麻酔', '分離肺', '切除', '分泌物', '換気血流']);
    // 4. ドレーン評価（他可能性の鑑別）・今後のリスク（進行・肺炎）と必要な対応
    const e4 = hasAny(['ドレーン', 'エアリーク', '再膨張', '皮下気腫', '気胸', '進行', '肺炎', 'リスク', '報告', '再評価', '対応']);

    const matched = [];
    const missing = [];
    if (e1) matched.push('①酸素化悪化の判断'); else missing.push('①現在、酸素化が悪化しているという明確な判断（SpO₂ 97→93%等）');
    if (e2) matched.push('②根拠となる患者情報（呼吸音・胸郭・X線・喀痰等）'); else missing.push('②根拠となる具体的な患者情報（左下肺野呼吸音減弱、副雑音、浅速呼吸、X線所見など）');
    if (e3) matched.push('③無気肺・換気低下の病態生理と複合要因'); else missing.push('③疼痛（NRS 7）による浅呼吸・咳嗽抑制や術前背景・手術要因が無気肺・換気低下につながる病態生理');
    if (e4) matched.push('④ドレーン評価・今後のリスク（無気肺進行・肺炎）と対応'); else missing.push('④胸腔ドレーン所見（少量エアリークの継続評価）や今後の無気肺進行・肺炎リスクと報告・対応');

    const count = [e1, e2, e3, e4].filter(Boolean).length;
    let level = '知識の再生';
    let levelCode = 'LEVEL_1';
    if (count === 4 || (e1 && e3 && e4 && e2)) {
      level = '臨床推論（高度な統合）';
      levelCode = 'LEVEL_4';
    } else if (e3 && (e1 || e2)) {
      level = '情報の統合（病態生理の関連づけ）';
      levelCode = 'LEVEL_3';
    } else if (e2 || (e1 && count >= 2)) {
      level = '情報の解釈（根拠の提示）';
      levelCode = 'LEVEL_2';
    }

    let feedback = `【ルーブリック到達水準：${level}】\n含まれていた要素：${matched.join(' ／ ') || '病態の指摘'}。`;
    if (missing.length > 0) {
      feedback += `\n💡 さらに高めるための視点：${missing.join('、')} までつなげて説明できると、「知識の再生・解釈」から「情報の統合・臨床推論」へと深まります。`;
    } else {
      feedback += `\n🌟 素晴らしい統合アセスメントです！①酸素化悪化の判断、②根拠となる観察・検査情報、③複合要因と無気肺の病態生理、④ドレーン評価と今後のリスク・対応の4要素がすべて論理的につながっています。`;
    }
    return { level, levelCode, matchedElements: matched, missingHints: missing, feedback };
  }

  // Scene 4（優先順位と回復促進の看護）
  const e1 = hasAny(['安全', '優先', '重症度', '酸素', 'ドレーン', '報告', '相談', '医師']);
  const e2 = hasAny(['疼痛', '鎮痛', '痛み', 'NRS', 'PCEA', '深呼吸', '排痰', '咳嗽', 'ハフィング', '体位']);
  const e3 = hasAny(['段階', '端座位', '離床', '回復', '予防', '無気肺', '廃用', '血栓']);
  const e4 = hasAny(['再評価', '効果', '改善', '実施後', '援助後', '呼吸音', 'SpO2', 'SpO₂']);

  const matched = [];
  const missing = [];
  if (e1) matched.push('①安全確認・呼吸状態の再評価・医師への報告相談'); else missing.push('①離床の前にまず呼吸状態・酸素・ドレーンを確認し医師へ報告・相談する優先順位');
  if (e2) matched.push('②鎮痛効果の評価と深呼吸・排痰・体位調整'); else missing.push('②疼痛（NRS 7）を緩和して深呼吸や排痰が行える状態を整える援助');
  if (e3) matched.push('③状態安定を確認しながらの段階的離床'); else missing.push('③呼吸状態の安定を確認しながら段階的に離床を進める視点');
  if (e4) matched.push('④援助後の効果の再評価（SpO₂・呼吸数・呼吸音・疼痛）'); else missing.push('④看護実施後にSpO₂・呼吸数・呼吸音・疼痛などを再評価して効果を確認する視点');

  const count = [e1, e2, e3, e4].filter(Boolean).length;
  let level = '知識の再生';
  let levelCode = 'LEVEL_1';
  if (count === 4) { level = '臨床推論（高度な統合）'; levelCode = 'LEVEL_4'; }
  else if (count === 3) { level = '情報の統合（病態生理の関連づけ）'; levelCode = 'LEVEL_3'; }
  else if (count === 2) { level = '情報の解釈（根拠の提示）'; levelCode = 'LEVEL_2'; }

  let feedback = `【記述評価：${level}】確認できた視点：${matched.join('、') || '看護援助の提案'}。`;
  if (missing.length > 0) {
    feedback += `\nさらに「${missing.join('」「')}」まで含めると、安全性を踏まえた優先順位と回復促進の看護・効果評価が一貫して説明できます。`;
  } else {
    feedback += `\n現在の安全性を踏まえた初期対応から、疼痛管理・排痰・段階的離床、そして援助後の再評価まで、患者の状態に即して一貫した説明ができています。`;
  }
  return { level, levelCode, matchedElements: matched, missingHints: missing, feedback };
}

// 臨床推論と患者結果の評価ロジック（第4回 肺がん患者の看護・4 Scene対応）
function evaluateSceneResult(sceneId, selectedInfo, decision, rationaleText = '') {
  const sid = String(sceneId);
  const rationaleEval = evaluateRationaleText(sid, rationaleText);

  // ================= SCENE 1 — BEFORE（術前リスク予測） =================
  if (sid === '1') {
    const hasSmoking = selectedInfo.includes('smoking_sputum');
    const hasSpiro = selectedInfo.includes('spirometry');
    const hasSurgery = selectedInfo.includes('surgery_anesthesia');
    const criticalCount = [hasSmoking, hasSpiro, hasSurgery].filter(Boolean).length;

    if (decision === 'predict-high-risk') {
      if (criticalCount === 3) {
        return {
          patientOutcome: 'STABLE',
          clinicalReasoning: 'SUFFICIENT_ASSESSMENT',
          resultType: 'Well-supported preoperative risk prediction',
          title: '患者背景と手術要因の相互作用を踏まえた的確な術前リスク予測',
          story: 'あなたたちは、Aさんの安静時SpO₂（97%）が保たれていることだけで安心せず、【喫煙歴・朝の白色痰・労作時息切れ】【FEV₁/FVC 64%（気流閉塞の示唆）】【全身麻酔・分離肺換気・左上葉切除・術後疼痛】の3領域を確実に確認しました。\n\nこれらが相互に影響することで、術後に分泌物貯留・肺胞換気低下・無気肺・低酸素血症が生じるリスクが高いと予測し、術前から腹式呼吸・深呼吸や創部保護（スプリンティング）を用いた有効な咳嗽・ハフィング、疼痛を我慢せず伝えることの重要性をAさんと共有できました。',
          reflectionQuestion: '「現在安静時のSpO₂が97%で安定していること」と「手術後の呼吸器合併症リスクが低いこと」がなぜイコールにならないのか、グループで記述したアセスメントを振り返ってみましょう。',
          rationaleEvaluation: rationaleEval
        };
      } else {
        const missed = [];
        if (!hasSmoking) missed.push('喫煙歴・日常の気道症状');
        if (!hasSpiro) missed.push('術前呼吸機能検査（FEV₁/FVC 64%）');
        if (!hasSurgery) missed.push('術式・全身麻酔・分離肺換気・術後疼痛の特徴');
        return {
          patientOutcome: 'STABLE',
          clinicalReasoning: 'PARTIAL_ASSESSMENT',
          resultType: 'Appropriate risk prediction with partial information',
          title: '適切な術前リスク予測（一部の重要根拠が未確認）',
          story: `術後の呼吸器合併症リスクが高いと予測し、術前からの呼吸・排痰指導を行う判断自体は適切でした。\n一方で、優先して確認すべき【${missed.join('、')}】が未選択であったため、「なぜAさんに無気肺や分泌物貯留が生じやすいのか」を患者背景と手術・麻酔・疼痛の相互作用から説明する根拠が一部不足していました。`,
          reflectionQuestion: `今回未確認だった【${missed.join('、')}】を加えると、Aさんの術後リスクの説明はどう深まるでしょうか？`,
          rationaleEvaluation: rationaleEval
        };
      }
    } else if (decision === 'assume-low-risk') {
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'MISSED_CRITICAL_CUE',
        resultType: 'Misconception: Normal SpO2 equals normal pulmonary reserve',
        title: 'PATIENT CONDITION CHANGED（術前リスクの過小評価による準備不足）',
        story: '「安静時のSpO₂が97%（室内気）だから肺機能に問題はない」と判断し、十分な呼吸・排痰練習や疼痛時の対処指導を行わないまま手術当日を迎えました。\n\nしかし、Aさんには45年間の喫煙歴、朝の白色痰、坂道での息切れ、FEV₁/FVC 64%という気流閉塞傾向があり、そこに全身麻酔・分離肺換気・左上葉切除・術後疼痛が重なったことで、術後に強い創部痛と喀痰困難が出現し、どう呼吸や咳をしてよいか分からずパニックになってしまいました。',
        reflectionQuestion: '「安静時のSpO₂が97%であること」は、なぜ「呼吸機能が正常で術後リスクが低い証拠」にはならないのでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'diagnose-copd-stop') {
      return {
        patientOutcome: 'STABLE',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Misconception: FEV1/FVC 64% alone confirms severe COPD',
        title: '検査値の短絡的な決めつけ（FEV₁/FVC 64%の解釈誤り）',
        story: 'FEV₁/FVC 64%という数値のみから「重度COPDが確定しており手術不能である」と判断しました。\n\nしかし、FEV₁/FVC 64%は気流閉塞を示唆する重要な所見であるものの、それ単独でCOPDが確定診断されるわけではありません（気管支拡張薬吸入後の評価や他疾患の除外が必要）。また、%VCは92%保たれており、手術の中止ではなく「気流閉塞傾向を踏まえた周術期の呼吸管理・合併症予防」こそが看護に求められます。',
        reflectionQuestion: '検査データから「気流閉塞が示唆される（リスクが高い）」と推論することと、「疾患が確定している・手術できない」と決めつけることの違いは何でしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      // inevitable-atelectasis
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Misconception: Deterministic view of smoking and atelectasis',
        title: 'リスク予測と確定の混同（「喫煙者＝必ず無気肺」という決めつけ）',
        story: '「喫煙者だから必ず無気肺になる」と断定し、術後は最初から機械的吸引を繰り返す方針を伝えました。Aさんは強い恐怖心を抱き、手術への意欲が低下してしまいました。\n\n喫煙歴や気流閉塞傾向は無気肺のリスク因子ですが、「必ず発症する」わけではありません。だからこそ、疼痛管理と深呼吸・有効な咳嗽支援・早期離床によって予防・早期改善を図る看護が重要になります。',
        reflectionQuestion: '「リスクが高いと予測して予防的看護を行うこと」と、「必ず合併症が起きると決めつけること」にはどのような違いがあるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    }
  }

  // ================= SCENE 2 — DURING（術後の変化への気づき・情報収集） =================
  if (sid === '2') {
    const hasBreath = selectedInfo.includes('breath_chest_wall');
    const hasPainSputum = selectedInfo.includes('pain_cough_sputum');
    const hasDrain = selectedInfo.includes('chest_drain');
    const hasXray = selectedInfo.includes('chest_xray');
    const hasConscious = selectedInfo.includes('consciousness_dyspnea');
    const keyRespCount = [hasBreath, hasPainSputum, hasDrain, hasXray].filter(Boolean).length;

    if (decision === 'assess-oxygenation-drop') {
      if (keyRespCount >= 2) {
        return {
          patientOutcome: 'STABLE',
          clinicalReasoning: 'SUFFICIENT_ASSESSMENT',
          resultType: 'Timely recognition of oxygenation drop and hypothesis-driven data collection',
          title: '時間的変化からの酸素化悪化の気づきと仮説検証型の情報収集',
          story: 'あなたたちは、術当日夕方と術後1日目朝を比較し、「同じ酸素2L/分投与下なのにSpO₂が97%から93%へ低下し、呼吸数が18回/分から24回/分へ増加、咳嗽時疼痛がNRS 5から7へ増強している」ことから、酸素化が悪化していると的確に判断しました。\n\nそのうえで、肺胞換気低下・分泌物貯留・無気肺・気胸やドレーン異常などの仮説を確かめるために、呼吸のフィジカルアセスメント・喀痰と疼痛・胸腔ドレーン・胸部X線などの重要情報を目的意識をもって収集できました。',
          reflectionQuestion: '今回収集した情報から、Aさんの左胸郭・左下肺野・気道内・胸腔内ではそれぞれ何が起きていると考えられますか？次のScene 3で統合してみましょう。',
          rationaleEvaluation: rationaleEval
        };
      } else {
        return {
          patientOutcome: 'STABLE',
          clinicalReasoning: 'PARTIAL_ASSESSMENT',
          resultType: 'Recognized deterioration but missed key respiratory physical/drain cues',
          title: '酸素化悪化への気づきは適切（局所呼吸所見・ドレーン情報の不足）',
          story: '夕方からの変化を捉えて「酸素化が悪化しており原因評価が必要である」と判断した点は適切でした。\nただし、選択した情報だけでは、左下肺野の呼吸音減弱・副雑音や喀痰困難、胸腔ドレーンの状態、胸部X線所見など、なぜ酸素化が悪化したのかを特定するための呼吸器フィジカル情報が不足していました。',
          reflectionQuestion: '全身の重症度確認に加えて、「なぜSpO₂が下がったのか」という局所の病態（換気・排痰・胸腔内）を確かめるにはどの情報が不可欠だったでしょうか？',
          rationaleEvaluation: rationaleEval
        };
      }
    } else if (decision === 'ignore-as-normal') {
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'MISSED_CRITICAL_CUE',
        resultType: 'Failed to compare temporal change (97% to 93%)',
        title: 'PATIENT CONDITION CHANGED（時間的変化の見落としによる呼吸状態の悪化）',
        story: '「SpO₂ 93%は術後によくある範囲内」と単一時点の数値だけで判断し、術当日夕方（SpO₂ 97%、RR 18回/分）からの時間的な悪化を見過ごして経過観察としました。\n\n数時間後、Aさんは粘稠痰による気道閉塞と無気肺の拡大によりSpO₂が88%まで低下し、強い呼吸困難と頻呼吸（30回/分）を呈する状態へと悪化してしまいました。',
        reflectionQuestion: '「現在の数値だけを見ること」と「術当日夕方から術後1日目朝への時間的な変化（Trend）を比較すること」では、判断にどのような違いが生まれるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'pain-only-view') {
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Premature closure on pain without respiratory assessment',
        title: 'PATIENT CONDITION CHANGED（疼痛のみへの短絡と呼吸器評価の欠如）',
        story: '呼吸数や脈拍の増加をすべて「創部痛によるもの」と決めつけ、呼吸音の聴診や胸腔ドレーンの確認を行わずに鎮痛薬のみを投与しました。\n\n痛みはわずかに和らいだものの、すでに生じていた粘稠痰の貯留と左下肺野の換気低下（無気肺）が見落とされたままとなり、SpO₂は92%へさらに低下しました。',
        reflectionQuestion: '疼痛は重要な要因ですが、酸素化が低下（SpO₂ 97%→93%）している患者で呼吸音や胸腔ドレーンを確認しないことにはどのような危険があるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      // blind-oxygen-up
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Blind oxygen escalation masking underlying pathology',
        title: 'PATIENT CONDITION CHANGED（原因未評価のままの酸素増量による病態マスク）',
        story: 'なぜSpO₂が低下したのかを観察・評価しないまま、独断で酸素流量を増量して見かけ上のSpO₂数値だけを引き上げました。\n\nパルスオキシメーターの数値は一時的に上がりましたが、左下肺野の無気肺や気道分泌物の貯留という根本原因は放置されたため、肺胞虚脱がさらに進行してしまいました。',
        reflectionQuestion: 'SpO₂という「結果の数値」だけを酸素増量で取り繕うことは、なぜ根本的な解決にならず危険なのでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    }
  }

  // ================= SCENE 3 — AFTER（情報の統合とアセスメント記述） =================
  if (sid === '3') {
    if (decision === 'integrated-clinical-reasoning') {
      const isHighLevel = rationaleEval.levelCode === 'LEVEL_4' || rationaleEval.levelCode === 'LEVEL_3';
      return {
        patientOutcome: 'STABLE',
        clinicalReasoning: isHighLevel ? 'SUFFICIENT_ASSESSMENT' : 'PARTIAL_ASSESSMENT',
        resultType: isHighLevel ? 'Comprehensive pathophysiological integration' : 'Correct conclusion, rationale needs deeper integration',
        title: isHighLevel
          ? '複数要因と病態生理を関連づけた統合的アセスメントの成立'
          : '病態判断は適切（自由記述での要因間の関連づけをさらに深めましょう）',
        story: `あなたたちは、術前背景（長期喫煙・気流閉塞傾向）、手術・麻酔の影響（全身麻酔・分離肺換気・左上葉切除）、そして術後疼痛（咳嗽時NRS 7）による浅呼吸と喀痰困難が相互に重なり、分泌物貯留と左下肺野の無気肺（換気血流比不均衡）によって酸素化が悪化（SpO₂ 97%→93%、RR 18→24回/分）していると統合的に判断しました。\nまた、胸腔ドレーンの咳嗽時少量エアリークについても、残存肺の再膨張や皮下気腫・出血の有無と合わせて冷静に評価し、今後の無気肺進行や肺炎リスクを見据えることができました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '自分たちが記述したアセスメント文章に「①酸素化悪化の判断」「②根拠となる患者情報」「③無気肺を疑う病態生理と関与する要因」「④ドレーン評価と今後のリスク・必要な対応」の4要素がどのようにつながっているか、クラス討議で確認してみましょう。',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'label-only-atelectasis') {
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'PARTIAL_ASSESSMENT',
        resultType: 'Single-factor labeling without pain/sputum integration',
        title: '病態名（無気肺）の指摘にとどまり、疼痛・喀痰との関連づけが不足',
        story: `胸部X線等から「無気肺」という病態には気づけましたが、現在の強い術後疼痛（咳嗽時NRS 7）による浅呼吸・咳嗽抑制や、長期喫煙に伴う粘稠痰の喀出困難が無気肺を引き起こし悪化させているという「複合要因のつながり」が捉えきれていませんでした。\nなぜ無気肺が起きているのかの要因が統合されないと、次のSceneで必要な「疼痛管理と排痰援助」へつながりません。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '単に「無気肺が起きている」と診断名のように言うことと、「なぜAさんに無気肺・換気低下が生じているのかを複数の要因から説明すること」では、導き出される看護がどう変わるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'airleak-main-cause') {
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Misinterpretation of minor cough air leak as tension pneumothorax',
        title: 'ドレーン所見の偏った解釈（他所見との統合不足）',
        story: `咳嗽時の少量のエアリークのみに注目し、重篤な気胸による肺完全虚脱と断定してしまいました。\nしかし、胸部X線では残存肺は概ね再膨張しており、皮下気腫や排液急増もありません。少量のエアリークは経過観察が必要ですが、現在の酸素化悪化の主因は疼痛（NRS 7）による浅呼吸・喀痰困難と左下肺野の無気肺・換気低下にあります。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '1つの所見（咳嗽時少量エアリーク）だけに飛びつかず、胸部X線や聴診・喀痰・疼痛の所見と統合して全体像を評価するにはどう考えればよかったでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      // no-complication-risk
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Underestimation of hypoxia and progression risk to pneumonia',
        title: 'PATIENT CONDITION CHANGED（酸素化悪化と無気肺進行・肺炎リスクの見落とし）',
        story: `意識清明で血圧が保たれていることから「異常なし・悪化リスクなし」と判断しました。\nしかし、すでに酸素化は悪化（SpO₂ 93%、RR 24回/分）しており、放置すれば無気肺の拡大や貯留分泌物への感染による術後肺炎・呼吸不全へ進行する高いリスクがありました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '現在の所見から「今後どのような悪化（無気肺の進行、肺炎など）が起こり得るか」まで予測することが、なぜ看護アセスメントにおいて重要なのでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    }
  }

  // ================= SCENE 4 — NEXT（看護の優先順位と回復促進の看護） =================
  if (sid === '4') {
    const hasSafety = selectedInfo.includes('safety_first_report');
    const hasPainCare = selectedInfo.includes('pain_sputum_positioning');
    const hasMobilizeEval = selectedInfo.includes('safe_mobilization_reassess');
    const criticalCount = [hasSafety, hasPainCare, hasMobilizeEval].filter(Boolean).length;

    if (decision === 'priority-reassess-pain-mobilize') {
      return {
        patientOutcome: 'STABLE',
        clinicalReasoning: criticalCount >= 2 ? 'SUFFICIENT_ASSESSMENT' : 'APPROPRIATE_DECISION',
        resultType: 'Safe prioritization, pain-airway-mobilization integration, and reassessment',
        title: '安全性を踏まえた優先順位判断と、疼痛管理・排痰・段階的離床・再評価の統合',
        story: `あなたたちは「すぐに離床させる」前にまず立ち止まり、酸素化が悪化しているAさんの現在の呼吸状態・酸素投与・胸腔ドレーンを再評価し、医師へ適切に報告・相談しました。\n\nそのうえで、咳嗽時NRS 7の疼痛に対して鎮痛効果を整え、ファーラー位への体位調整と創部保護（スプリンティング）を行いながら深呼吸・ハフィングを支援したところ、Aさんは粘稠な白色痰を喀出することができました。\n呼吸状態と疼痛が落ち着いていることを確認しながら端座位・立位へと段階的に離床を進め、援助後の再評価では【SpO₂ 97%（O₂ 2L/分）、呼吸数 18回/分、左下肺野の呼吸音改善、咳嗽時疼痛 NRS 3】へと回復が確認されました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '「疼痛管理」「呼吸・排痰援助」「体位調整」「段階的な早期離床」「実施後の再評価」が、Aさんの病態生理の上でどのようにつながっていたか振り返ってみましょう。',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'immediate-walk-immediately' || decision === 'immediate-walk-first') {
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Forced mobilization without safety check or pain control',
        title: 'PATIENT CONDITION CHANGED（安全確認・鎮痛なしの無理な離床による状態悪化）',
        story: `「早期離床が大事だから」と、現在の呼吸状態の再評価・報告や鎮痛を行わないまま、SpO₂ 93%・疼痛NRS 7のAさんを無理に立たせて歩かせようとしました。\n\nその前に、Aさんは今、安全に離床を進めてよい状態だったでしょうか？\n強い創部痛と酸素消費量の増大によりAさんは激しい息苦しさと冷汗を訴え、SpO₂は88%まで急低下し、ベッドへ戻さざるを得なくなりました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '「早期離床が有効である」という一般論と、「今この瞬間のAさんが安全に離床できる状態か」を判断することには、どのような違いがあるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'cancel-all-care-rest') {
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Abandoned airway clearance and positioning due to pain/hypoxia',
        title: 'PATIENT CONDITION CHANGED（排痰援助・体位調整の放棄による無気肺の遷延）',
        story: `Aさんの「痛いから動きたくない」という言葉とSpO₂ 93%という数値から、排痰援助や体位調整、段階的離床のすべてを中止し、そのまま仰臥位で寝かせ続けました。\n\nその結果、気道内の粘稠痰はさらに貯留し、翌日には左下葉の無気肺の拡大と38.5℃の発熱（術後肺炎）を併発してしまいました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '「無理に歩かせないこと」と「鎮痛・体位調整・排痰援助まで何もせず寝かせきりにすること」は全く異なります。動きたくないと話す患者に、看護師はどう関わるべきだったでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      // give-painkiller-only
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'PARTIAL_ASSESSMENT',
        resultType: 'Analgesia only without airway clearance, reporting, or reassessment',
        title: 'PATIENT CONDITION CHANGED（鎮痛薬投与のみで排痰・離床・再評価につながらず）',
        story: `鎮痛薬のみを投与して「痛みが落ち着いたら休んでくださいね」と退室し、呼吸状態の報告や、鎮痛効果が出たタイミングでの深呼吸・排痰援助、段階的離床、および実施後の再評価を行いませんでした。\n\nAさんは痛みが和らいだもののそのまま眠ってしまい、浅呼吸と分泌物貯留が改善されないままSpO₂低下が遷延しました。\n\n${rationaleEval.feedback}`,
        reflectionQuestion: '術後の鎮痛は「ただ眠らせるため」だけでなく、「深呼吸・有効な咳嗽（排痰）・段階的離床を行える状態を整えるため」に行います。鎮痛後にどのような援助と再評価が必要だったでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    }
  }

  return {
    patientOutcome: 'STABLE',
    clinicalReasoning: 'APPROPRIATE_DECISION',
    resultType: 'Standard evaluation',
    title: '評価完了',
    story: 'アセスメントおよび臨床判断を完了しました。',
    reflectionQuestion: '今回の判断プロセスについてグループで振り返ってみましょう。',
    rationaleEvaluation: rationaleEval
  };
}

// クライアント向けレスポンスビルダー
function buildClientPayload(groupState) {
  const currentSceneId = groupState.currentScene;
  const currentSceneState = groupState.scenes[currentSceneId];
  const globalSceneStatus = sceneStatuses[currentSceneId];

  let displayPhase = currentSceneState.phase;
  if (globalSceneStatus === 'RESULTS_RELEASED') {
    displayPhase = 'result';
  } else if (globalSceneStatus === 'RESOLVED') {
    displayPhase = 'resolved';
  }

  const sanitizedScenes = {};
  for (let i = 1; i <= 4; i++) {
    const s = groupState.scenes[i];
    const isReleased = sceneStatuses[i] === 'RESULTS_RELEASED' || sceneStatuses[i] === 'RESOLVED';
    const isResolved = sceneStatuses[i] === 'RESOLVED';

    sanitizedScenes[i] = {
      sceneId: s.sceneId,
      phase: s.phase,
      selectedInfo: s.selectedInfo,
      budget: s.budget,
      remainingBudget: s.remainingBudget,
      decision: s.decision,
      rationaleText: s.rationaleText,
      submittedAt: s.submittedAt,
      result: isReleased ? s.result : null,
      canonicalStory: isResolved ? scenarioData.scenes[String(i)]?.canonicalStory : null
    };
  }

  return {
    groupId: groupState.groupId,
    groupName: groupState.groupName,
    currentScene: currentSceneId,
    displayPhase,
    sceneStatus: globalSceneStatus,
    sceneStatuses: sceneStatuses,
    scenario: scenarioData,
    scenes: sanitizedScenes
  };
}

// 教員管理画面向け集計データビルダー
function buildAdminSummary() {
  const groupsList = Array.from(groups.values());

  const summary = {
    networkInfo: globalNetworkInfo,
    sceneStatuses,
    totalGroups: groupsList.length,
    groups: groupsList.map(g => {
      const currentSceneState = g.scenes[g.currentScene];
      const sceneDef = scenarioData.scenes[String(g.currentScene)];
      const decObj = (sceneDef?.decisions || []).find(d => d.id === currentSceneState.decision);
      return {
        groupId: g.groupId,
        groupName: g.groupName,
        currentScene: g.currentScene,
        scenePhase: currentSceneState.phase,
        budgetUsed: currentSceneState.budget - currentSceneState.remainingBudget,
        budgetTotal: currentSceneState.budget,
        selectedInfo: currentSceneState.selectedInfo,
        decision: currentSceneState.decision,
        decisionLabel: decObj ? decObj.label.split('．')[0] + '．' + decObj.label.split('．').slice(1).join('．').slice(0, 24) + '...' : (currentSceneState.decision || '未決定'),
        rationaleText: currentSceneState.rationaleText || '',
        rationaleLevel: currentSceneState.result?.rationaleEvaluation?.level || '未評価',
        rationaleLevelCode: currentSceneState.result?.rationaleEvaluation?.levelCode || 'NONE',
        resultType: currentSceneState.result?.resultType || '未判定',
        patientOutcome: currentSceneState.result?.patientOutcome || '未確定',
        clinicalReasoning: currentSceneState.result?.clinicalReasoning || '未確定',
        submittedAt: currentSceneState.submittedAt,
        allScenes: Object.keys(g.scenes).reduce((acc, sid) => {
          const sc = g.scenes[sid];
          acc[sid] = {
            phase: sc.phase,
            selectedInfo: sc.selectedInfo,
            decision: sc.decision,
            rationaleText: sc.rationaleText || '',
            rationaleLevel: sc.result?.rationaleEvaluation?.level || '未評価',
            patientOutcome: sc.result?.patientOutcome || '未確定',
            clinicalReasoning: sc.result?.clinicalReasoning || '未確定',
            highlightedInDebrief: !!sc.highlightedInDebrief
          };
          return acc;
        }, {})
      };
    }),
    debrief: {}
  };

  for (let i = 1; i <= 4; i++) {
    const sid = String(i);
    const sceneDef = scenarioData.scenes[sid];
    if (!sceneDef) continue;

    const infoCounts = {};
    (sceneDef.infoItems || []).forEach(item => {
      infoCounts[item.id] = { label: item.label, count: 0, percentage: 0 };
    });

    const decisionCounts = {};
    (sceneDef.decisions || []).forEach(dec => {
      decisionCounts[dec.id] = { label: dec.label, count: 0, percentage: 0 };
    });

    const outcomeCounts = {
      STABLE: 0,
      CONDITION_CHANGED: 0,
      DETERIORATED: 0
    };

    const reasoningCounts = {};
    const rationaleEntries = [];
    let totalSubmissionsInScene = 0;

    groupsList.forEach((g, idx) => {
      const s = g.scenes[i];
      if (s && s.submittedAt) {
        totalSubmissionsInScene++;
        s.selectedInfo.forEach(infoId => {
          if (infoCounts[infoId]) infoCounts[infoId].count++;
        });
        if (s.decision && decisionCounts[s.decision]) {
          decisionCounts[s.decision].count++;
        }
        if (s.result) {
          if (outcomeCounts[s.result.patientOutcome] !== undefined) {
            outcomeCounts[s.result.patientOutcome]++;
          }
          const cr = s.result.clinicalReasoning;
          if (cr) {
            reasoningCounts[cr] = (reasoningCounts[cr] || 0) + 1;
          }
        }
        const decObj = (sceneDef.decisions || []).find(d => d.id === s.decision);
        const shortDec = decObj ? decObj.label.slice(0, 28) + (decObj.label.length > 28 ? '…' : '') : (s.decision || '');
        rationaleEntries.push({
          groupId: g.groupId,
          groupName: g.groupName,
          anonymousLabel: `グループ ${String.fromCharCode(65 + (idx % 26))}`,
          decisionId: s.decision,
          decisionShort: shortDec,
          rationaleText: s.rationaleText || '',
          rationaleLevel: s.result?.rationaleEvaluation?.level || '未評価',
          rationaleLevelCode: s.result?.rationaleEvaluation?.levelCode || 'NONE',
          matchedElements: s.result?.rationaleEvaluation?.matchedElements || [],
          highlighted: !!s.highlightedInDebrief,
          submittedAt: s.submittedAt
        });
      }
    });

    if (totalSubmissionsInScene > 0) {
      Object.keys(infoCounts).forEach(k => {
        infoCounts[k].percentage = Math.round((infoCounts[k].count / totalSubmissionsInScene) * 100);
      });
      Object.keys(decisionCounts).forEach(k => {
        decisionCounts[k].percentage = Math.round((decisionCounts[k].count / totalSubmissionsInScene) * 100);
      });
    }

    summary.debrief[i] = {
      sceneId: i,
      clinicalQuestion: sceneDef.clinicalQuestion,
      debriefFocus: sceneDef.debriefFocus,
      debriefQuestions: sceneDef.debriefQuestions || [],
      rationalePrompt: sceneDef.rationalePrompt || '',
      totalSubmissions: totalSubmissionsInScene,
      infoCounts: Object.values(infoCounts),
      decisionCounts: Object.values(decisionCounts),
      outcomeCounts,
      reasoningCounts,
      rationaleEntries
    };
  }

  return summary;
}

function broadcastGroupUpdates() {
  groups.forEach((groupState) => {
    io.to(`group_${groupState.groupId}`).emit('game-state-updated', buildClientPayload(groupState));
  });
  io.emit('admin-summary-updated', buildAdminSummary());
}

// --- Socket.IO 通信 ---

io.on('connection', (socket) => {
  socket.on('register-group', (data) => {
    const groupName = typeof data === 'string' ? data : data?.groupName;
    if (!groupName || groupName.trim() === '') {
      return socket.emit('error-msg', { message: 'グループ名を入力してください' });
    }
    const groupId = uuidv4();
    const groupState = createGroupState(groupId, groupName.trim());
    groups.set(groupId, groupState);
    socket.join(`group_${groupId}`);

    socket.emit('registered', buildClientPayload(groupState));
    io.emit('admin-summary-updated', buildAdminSummary());
    console.log(`[Student] Registered: ${groupName} (${groupId})`);
  });

  socket.on('rejoin-group', (data) => {
    const groupId = typeof data === 'string' ? data : data?.groupId;
    if (groups.has(groupId)) {
      const groupState = groups.get(groupId);
      socket.join(`group_${groupId}`);
      socket.emit('rejoined', buildClientPayload(groupState));
      console.log(`[Student] Rejoined: ${groupState.groupName} (${groupId})`);
    } else {
      socket.emit('rejoin-failed', { message: 'グループ情報が見つかりません。再登録してください。' });
    }
  });

  socket.on('get-state', (data) => {
    const groupId = typeof data === 'string' ? data : data?.groupId;
    if (groupId && groups.has(groupId)) {
      socket.emit('game-state-updated', buildClientPayload(groups.get(groupId)));
    }
  });

  socket.on('select-info', (data) => {
    const { groupId, sceneId, infoId } = data || {};
    if (!groups.has(groupId)) return;

    const groupState = groups.get(groupId);
    const sid = parseInt(sceneId);

    if (sceneStatuses[sid] !== 'ACTIVE') {
      return socket.emit('error-msg', { message: 'このSceneは現在選択を受け付けていません' });
    }

    const sceneState = groupState.scenes[sid];
    if (sceneState.phase !== 'assessment') {
      return socket.emit('error-msg', { message: 'すでに判断を送信済みです' });
    }
    if (sceneState.remainingBudget <= 0) {
      return socket.emit('error-msg', { message: 'Information Budgetがありません' });
    }
    if (sceneState.selectedInfo.includes(infoId)) {
      return socket.emit('error-msg', { message: 'すでに確認済みの情報です' });
    }

    sceneState.selectedInfo.push(infoId);
    sceneState.remainingBudget -= 1;

    socket.emit('game-state-updated', buildClientPayload(groupState));
    io.emit('admin-summary-updated', buildAdminSummary());
  });

  socket.on('submit-decision', (data) => {
    const { groupId, sceneId, decisionId, rationaleText } = data || {};
    if (!groups.has(groupId)) return;

    const groupState = groups.get(groupId);
    const sid = parseInt(sceneId);

    if (sceneStatuses[sid] !== 'ACTIVE') {
      return socket.emit('error-msg', { message: 'このSceneは現在送信を受け付けていません' });
    }

    const sceneState = groupState.scenes[sid];
    if (sceneState.phase !== 'assessment') {
      return socket.emit('error-msg', { message: 'すでに送信済みです' });
    }

    const sceneDef = scenarioData.scenes[String(sid)];
    const minLen = sceneDef?.rationaleMinLength ?? 30;
    const maxLen = sceneDef?.rationaleMaxLength ?? 400;
    const cleanedRationale = (rationaleText || '').trim();

    if (!decisionId) {
      return socket.emit('error-msg', { message: '看護判断の選択肢（A〜D）を選択してください' });
    }
    if (cleanedRationale.length < minLen) {
      return socket.emit('error-msg', { message: `アセスメント理由を${minLen}文字以上で記述してください（現在${cleanedRationale.length}文字）` });
    }
    if (cleanedRationale.length > maxLen) {
      return socket.emit('error-msg', { message: `アセスメント理由は${maxLen}文字以内で記述してください` });
    }

    sceneState.decision = decisionId;
    sceneState.rationaleText = cleanedRationale;
    sceneState.submittedAt = new Date().toISOString();
    sceneState.phase = 'submitted';

    // 内部で事前にResultを算出・記録（学生にはRESULTS_RELEASEDまで非公開）
    sceneState.result = evaluateSceneResult(sid, sceneState.selectedInfo, decisionId, cleanedRationale);

    socket.emit('game-state-updated', buildClientPayload(groupState));
    io.emit('admin-summary-updated', buildAdminSummary());
    console.log(`[Student] Decision & Rationale submitted by ${groupState.groupName} for Scene ${sid}: ${decisionId} (${cleanedRationale.length} chars)`);
  });

  // 教員管理画面
  socket.on('admin-login', (data) => {
    const password = typeof data === 'string' ? data : data?.password;
    if (FALLBACK_PASSWORDS.includes(password)) {
      socket.emit('admin-auth-result', { success: true });
      socket.emit('admin-summary-updated', buildAdminSummary());
    } else {
      socket.emit('admin-auth-result', { success: false });
    }
  });

  socket.on('admin-get-summary', () => {
    socket.emit('admin-summary-updated', buildAdminSummary());
  });

  socket.on('admin-toggle-highlight-rationale', (data) => {
    const { groupId, sceneId } = data || {};
    const sid = parseInt(sceneId);
    if (groups.has(groupId)) {
      const g = groups.get(groupId);
      if (g.scenes[sid]) {
        g.scenes[sid].highlightedInDebrief = !g.scenes[sid].highlightedInDebrief;
        io.emit('admin-summary-updated', buildAdminSummary());
      }
    }
  });

  socket.on('admin-open-scene', (data) => {
    const sid = parseInt(data.sceneId);
    sceneStatuses[sid] = 'ACTIVE';

    groups.forEach(g => {
      if (g.currentScene === sid && g.scenes[sid].phase !== 'submitted') {
        g.scenes[sid].phase = 'assessment';
      }
    });

    broadcastGroupUpdates();
    console.log(`[Admin] Scene ${sid} is now ACTIVE (OPEN)`);
  });

  socket.on('admin-release-results', (data) => {
    const sid = parseInt(data.sceneId);
    sceneStatuses[sid] = 'RESULTS_RELEASED';

    groups.forEach(g => {
      const s = g.scenes[sid];
      if (s && !s.result) {
        const defaultDec = scenarioData.scenes[String(sid)]?.decisions?.[0]?.id || 'predict-high-risk';
        s.result = evaluateSceneResult(sid, s.selectedInfo, s.decision || defaultDec, s.rationaleText || '');
      }
    });

    broadcastGroupUpdates();
    console.log(`[Admin] Scene ${sid} RESULTS RELEASED`);
  });

  socket.on('admin-resolve-scene', (data) => {
    const sid = parseInt(data.sceneId);
    sceneStatuses[sid] = 'RESOLVED';

    broadcastGroupUpdates();
    console.log(`[Admin] Scene ${sid} RESOLVED (Canonical Story revealed)`);
  });

  socket.on('admin-open-next-scene', (data) => {
    const currentSid = parseInt(data.currentSceneId);
    const nextSid = currentSid + 1;

    if (nextSid <= 4) {
      sceneStatuses[nextSid] = 'ACTIVE';

      groups.forEach(g => {
        g.currentScene = nextSid;
        g.scenes[nextSid].phase = 'assessment';
      });

      broadcastGroupUpdates();
      console.log(`[Admin] Next Scene ${nextSid} is now ACTIVE (OPEN)`);
    }
  });

  socket.on('admin-reset-all', () => {
    groups.clear();
    sceneStatuses = { 1: 'ACTIVE', 2: 'LOCKED', 3: 'LOCKED', 4: 'LOCKED' };
    io.emit('admin-reset-done');
    broadcastGroupUpdates();
    console.log('[Admin] Reset all data complete');
  });

  socket.on('disconnect', () => {});
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] || 'localhost';
    console.log(`====================================================`);
    console.log(`第4回「肺がん患者の看護」Clinical Reasoning Simulation`);
    console.log(`----------------------------------------------------`);
    console.log(`【PCローカルでの利用】`);
    console.log(`  学生画面:     http://localhost:${PORT}/`);
    console.log(`  教員管理画面: http://localhost:${PORT}/admin`);
    console.log(`----------------------------------------------------`);
    console.log(`【外部端末（スマホ・タブレット・他PC）からの利用】`);
    console.log(`  学生用アクセスURL: http://${primaryIp}:${PORT}/`);
    console.log(`  教員管理画面:     http://${primaryIp}:${PORT}/admin`);
    if (ips.length > 1) {
      console.log(`  その他検出されたIP: ${ips.join(', ')}`);
    }
    console.log(`----------------------------------------------------`);
    console.log(`管理パスワード: ${ADMIN_PASSWORD} (または cardiac2024)`);
    console.log(`====================================================`);
  });
}

module.exports = {
  app,
  server,
  io,
  evaluateSceneResult,
  evaluateRationaleText,
  scenarioData
};
