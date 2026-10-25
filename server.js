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

let publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;

let globalNetworkInfo = {
  ips: getLocalIpAddresses(),
  primaryIp: getLocalIpAddresses()[0] || 'localhost',
  studentUrl: publicUrl || `http://${getLocalIpAddresses()[0] || 'localhost'}:${PORT}/`,
  adminUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/admin` : `http://${getLocalIpAddresses()[0] || 'localhost'}:${PORT}/admin`,
  isPublic: !!publicUrl,
  qrCodeDataUrl: null
};

async function initNetworkInfo() {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  const cleanPublic = publicUrl ? publicUrl.replace(/\/$/, '') : null;
  const studentUrl = cleanPublic ? `${cleanPublic}/` : `http://${primaryIp}:${PORT}/`;
  const adminUrl = cleanPublic ? `${cleanPublic}/admin` : `http://${primaryIp}:${PORT}/admin`;
  try {
    const qr = await QRCode.toDataURL(studentUrl, {
      margin: 2,
      width: 256,
      color: { dark: '#1a365d', light: '#ffffff' }
    });
    globalNetworkInfo = { ips, primaryIp, studentUrl, adminUrl, isPublic: !!cleanPublic, qrCodeDataUrl: qr };
  } catch (e) {
    console.error('QR code generation error:', e);
  }
}
initNetworkInfo();

// 外部トンネルやクラウド経由のアクセス時に自動で公開URLを検出・反映するミドルウェア
app.use((req, res, next) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!publicUrl && host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1') && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    publicUrl = `${proto}://${host}`;
    initNetworkInfo().then(() => {
      io.emit('admin-summary-updated', buildAdminSummary());
    });
  }
  next();
});

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
  return scenarioData.scenes[sid]?.budget || 5;
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
    selectedDecisions: [], // Scene 3 (AFTER 2) 複数選択用
    rationaleText: '',
    highlightedInDebrief: false,
    submittedAt: null,
    result: null
  };
}

// 自由記述アセスメント（rationaleText）の形成的ルーブリック評価（Scene別評価観点対応）
function evaluateRationaleText(sceneId, rationaleText) {
  const sid = String(sceneId);
  const text = (rationaleText || '').trim();
  const formativeNote = '※この自動評価は形成的フィードバックの補助です。キーワードの有無だけで文章の質を断定するものではなく、教員による確認と全体討議を優先します。';

  // Scene 3 (AFTER 2) は複数選択式のため自由記述評価は任意メモ扱い
  if (sid === '3') {
    return {
      level: text ? '記述メモあり' : '複数選択評価',
      levelCode: 'MULTI_SELECT',
      matchedElements: [],
      missingHints: [],
      feedback: text ? `記入メモ：「${text}」` : '胸腔ドレーンの複数選択アセスメントを実施しました。',
      formativeNote
    };
  }

  if (!text) {
    return {
      level: '未記述',
      levelCode: 'NONE',
      matchedElements: [],
      missingHints: ['自由記述が入力されていません。'],
      feedback: '患者情報や病態生理に基づいた考えを自分の言葉で記述してみましょう。',
      formativeNote
    };
  }

  const hasAny = (keywords) => keywords.some(k => text.includes(k));

  // ================= SCENE 1：BEFORE（術前呼吸機能のアセスメント） =================
  // 評価観点：患者情報の選択、意味づけ、情報間の関連づけ、術後リスク予測
  if (sid === '1') {
    const e1 = hasAny(['喫煙', 'たばこ', 'タバコ', '45年', '喀痰', '痰', '息切れ', '坂道', '68歳', '加齢']);
    const e2 = hasAny(['64', 'FEV', '1秒率', '気流閉塞', '閉塞性', 'SpO2', 'SpO₂', '97', 'クリアランス', '線毛']);
    const e3 = hasAny(['左上葉切除', '肺切除', '胸腔鏡', '肺容量', '全身麻酔', '分離肺換気', '片肺', '疼痛', '痛み', '創痛', '浅呼吸', '咳嗽']);
    const e4 = hasAny(['無気肺', '分泌物', '貯留', '排痰', '換気低下', '低酸素', '肺炎', '合併症']);

    const matched = [];
    const missing = [];
    if (e1) matched.push('患者情報の選択（喫煙歴・喀痰・息切れ・年齢）');
    else missing.push('長期喫煙歴や朝の喀痰・坂道での息切れ・年齢といった患者背景');

    if (e2) matched.push('検査・所見の意味づけ（FEV₁/FVC 64％による気流閉塞や線毛機能低下、安静時SpO₂ 97％の解釈）');
    else missing.push('FEV₁/FVC 64％が示す気流閉塞や気道クリアランス低下、安静時SpO₂ 97％の意味づけ');

    if (e3) matched.push('手術・麻酔・疼痛との関連づけ（左上葉切除・全身麻酔・分離肺換気・術後疼痛）');
    else missing.push('胸腔鏡下左上葉切除術（肺容量減少）や全身麻酔・分離肺換気、術後疼痛による深呼吸・咳嗽抑制との関連づけ');

    if (e4) matched.push('術後呼吸状態の予測（分泌物貯留・換気低下・無気肺・低酸素血症リスク）');
    else missing.push('術後に予測される具体的な状態（気道分泌物貯留・肺胞換気低下・無気肺・低酸素血症など）');

    const count = [e1, e2, e3, e4].filter(Boolean).length;
    let level = 'LEVEL 1（知識の再生）';
    let levelCode = 'LEVEL_1';
    if (count === 4) {
      level = 'LEVEL 4（臨床推論・高度な統合）';
      levelCode = 'LEVEL_4';
    } else if (count === 3 || (e3 && e4 && (e1 || e2))) {
      level = 'LEVEL 3（情報の統合・関連づけ）';
      levelCode = 'LEVEL_3';
    } else if (count === 2) {
      level = 'LEVEL 2（情報の解釈・意味づけ）';
      levelCode = 'LEVEL_2';
    }

    let feedback = `【形成的フィードバック：${level}】\n・確認できた観点：${matched.join(' ／ ') || '術後リスクへの着目'}。`;
    if (missing.length > 0) {
      feedback += `\n・さらに深める視点：${missing.join('、')} をつなげて記述すると、患者要因と手術・麻酔要因の相互作用がより明確になります。`;
    } else {
      feedback += `\n・患者側の呼吸器背景・検査の意味づけと、手術・麻酔・術後疼痛の影響を関連づけ、術後に予測される呼吸状態を論理的に統合できています。`;
    }
    return { level, levelCode, matchedElements: matched, missingHints: missing, feedback, formativeNote };
  }

  // ================= SCENE 2：AFTER（術直後の呼吸状態） =================
  // 評価観点：換気低下の認識、SpO₂の解釈、麻酔・鎮痛薬の影響、病態生理、安全性の判断
  if (sid === '2') {
    const e1 = hasAny(['呼吸数', '9回', '９回', '浅', '換気低下', '低換気', '分時換気', '肺胞換気', '一回換気']);
    const e2 = hasAny(['SpO2', 'SpO₂', '96', '酸素', '3L', '３L', '換気できているとは', '評価できない', 'マスク', '見かけ']);
    const e3 = hasAny(['麻酔', 'オピオイド', 'PCA', '鎮痛', '呼吸抑制', '傾眠', '眠', '呼吸音', '減弱', '背側', '無気肺', '疼痛', 'NRS']);
    const e4 = hasAny(['CO2', 'CO₂', '二酸化炭素', '蓄積', '貯留', 'ナルコーシス', '血液ガス', '安全', '再評価', '報告', '医師', '対応']);

    const matched = [];
    const missing = [];
    if (e1) matched.push('換気低下の認識（呼吸数9回/分・浅呼吸からの分時/肺胞換気量低下）');
    else missing.push('呼吸数9回/分と浅くゆっくりした呼吸から、分時換気量・肺胞換気量の低下を疑う視点');

    if (e2) matched.push('SpO₂の適切な解釈（酸素投与下のSpO₂ 96％だけでは換気十分とは言えない）');
    else missing.push('酸素3L/分投与中のSpO₂ 96％のみでは十分に換気できているとは判断できない点（酸素化と換気の違い）');

    if (e3) matched.push('麻酔・鎮痛薬の影響と病態生理（呼吸抑制・傾眠傾向・疼痛・背側呼吸音減弱/無気肺）');
    else missing.push('全身麻酔やオピオイドPCAによる呼吸抑制の可能性、および背側肺底部の呼吸音減弱・疼痛から無気肺等を考慮する病態生理');

    if (e4) matched.push('安全性の判断（CO₂蓄積リスク・速やかな再評価と医師への報告・対応）');
    else missing.push('CO₂蓄積（高二酸化炭素血症）や呼吸状態悪化のリスクを踏まえた、速やかな再評価・報告・対応の必要性');

    const count = [e1, e2, e3, e4].filter(Boolean).length;
    let level = 'LEVEL 1（知識の再生）';
    let levelCode = 'LEVEL_1';
    if (count === 4) {
      level = 'LEVEL 4（臨床推論・高度な統合）';
      levelCode = 'LEVEL_4';
    } else if (count === 3 || (e1 && e2 && e3)) {
      level = 'LEVEL 3（情報の統合・病態生理の関連づけ）';
      levelCode = 'LEVEL_3';
    } else if (count === 2) {
      level = 'LEVEL 2（情報の解釈・根拠の提示）';
      levelCode = 'LEVEL_2';
    }

    let feedback = `【形成的フィードバック：${level}】\n・確認できた観点：${matched.join(' ／ ') || '術直後の変化への着目'}。`;
    if (missing.length > 0) {
      feedback += `\n・さらに深める視点：${missing.join('、')} を含めると、「酸素化と換気の違い」および「安全確保の緊急性」がより明確になります。`;
    } else {
      feedback += `\n・酸素投与下のSpO₂ 96％に惑わされず呼吸数9回/分・浅呼吸から換気低下を見抜き、麻酔・オピオイドの影響や背側無気肺、CO₂蓄積リスク、速やかな報告・対応まで一貫して説明できています。`;
    }
    return { level, levelCode, matchedElements: matched, missingHints: missing, feedback, formativeNote };
  }

  // ================= SCENE 4：NEXT（初回離床の看護判断） =================
  // 評価観点：患者の意思の尊重、疼痛への対応、離床の目的、安全確認、具体的援助の提案
  const e1 = hasAny(['痛', 'つらい', '辛', '心配', '不安', '気持ち', '無理', 'よね', 'ね。', '受け止め', '共感']);
  const e2 = hasAny(['肺', '広げ', '膨ら', '換気', '痰', '排痰', '無気肺', '肺炎', '合併症', '予防', '回復', '目的']);
  const e3 = hasAny(['鎮痛', '痛み止め', '薬', '支え', '押さえ', '保護', 'タオル', 'ドレーン', '管', 'めまい', '血圧', '付き添']);
  const e4 = hasAny(['まず', '段階', '少し', '頭を起こ', 'ギャッジ', '座る', '端座位', '相談', '一緒に', 'いかが', 'みませんか', 'どうですか']);

  const matched = [];
  const missing = [];
  if (e1) matched.push('患者の痛みや不安の受け止め');
  else missing.push('「動くと痛い」「管が心配」というAさんの訴え・不安を受け止める言葉');

  if (e2) matched.push('早期離床の目的の説明（肺の再膨張・排痰・無気肺や肺炎の予防）');
  else missing.push('なぜ離床が必要なのか（肺を広げる・痰を出しやすくする・無気肺や肺炎を防ぐ等）の目的説明');

  if (e3) matched.push('疼痛への対応と安全確認を伴う具体的援助（鎮痛薬・創部保護・ドレーン保持・めまい/血圧確認）');
  else missing.push('痛み止めの使用や創部保護、ドレーン保持、めまい・血圧確認などの具体的な安全援助の提案');

  if (e4) matched.push('患者の意思の尊重と段階的な離床の提案（端座位やギャッジアップから一緒に試す提案）');
  else missing.push('いきなり歩行を強制せず、まずはベッドを起こす・座るなど段階的な方法を提案し患者の同意を尋ねる表現');

  const count = [e1, e2, e3, e4].filter(Boolean).length;
  let level = 'LEVEL 1（知識の再生）';
  let levelCode = 'LEVEL_1';
  if (count === 4) {
    level = 'LEVEL 4（臨床推論・高度な統合）';
    levelCode = 'LEVEL_4';
  } else if (count === 3) {
    level = 'LEVEL 3（情報の統合・援助の関連づけ）';
    levelCode = 'LEVEL_3';
  } else if (count === 2) {
    level = 'LEVEL 2（情報の解釈・根拠の提示）';
    levelCode = 'LEVEL_2';
  }

  let feedback = `【形成的フィードバック：${level}】\n・確認できた観点：${matched.join(' ／ ') || '離床への声かけ'}。`;
  if (missing.length > 0) {
    feedback += `\n・さらに深める視点：${missing.join('、')} を声かけに加えると、患者の意思を尊重しながら安全に離床を支援する看護がより伝わりやすくなります。`;
  } else {
    feedback += `\n・Aさんの痛みと不安に寄り添いながら、早期離床の目的、鎮痛・創部/ドレーン保護の具体策、そして段階的な提案と意思確認が温かく論理的に表現されています。`;
  }
  return { level, levelCode, matchedElements: matched, missingHints: missing, feedback, formativeNote };
}

// 臨床推論と患者結果の評価ロジック（第4回 変更仕様書 4 Scene 完全対応）
function evaluateSceneResult(sceneId, selectedInfo, decision, rationaleText = '', selectedDecisions = []) {
  const sid = String(sceneId);
  const sceneDef = scenarioData.scenes[sid];
  const rationaleEval = evaluateRationaleText(sid, rationaleText);

  // ================= SCENE 1：BEFORE（術前呼吸機能のアセスメント） =================
  if (sid === '1') {
    const highPriorityIds = ['age_68', 'smoking_history', 'morning_sputum', 'slope_dyspnea', 'fev1_fvc_64', 'spo2_97_ra', 'vats_lul', 'ga_olv'];
    const suppIds = ['history_ht', 'family_garden'];

    const selectedHigh = selectedInfo.filter(id => highPriorityIds.includes(id));
    const missedHigh = highPriorityIds.filter(id => !selectedInfo.includes(id));
    const selectedSupp = selectedInfo.filter(id => suppIds.includes(id));

    const itemMap = {};
    (sceneDef?.infoItems || []).forEach(it => { itemMap[it.id] = it.label; });

    const strengths = [];
    const furtherPoints = [];

    if (selectedHigh.length >= 6) {
      strengths.push(`呼吸機能のアセスメントに直結する重要情報（${selectedHigh.map(id => itemMap[id]).join('、')}）を的確に選択できています。`);
    } else if (selectedHigh.length >= 3) {
      strengths.push(`選択した情報（${selectedHigh.map(id => itemMap[id]).join('、')}）の意味づけを確認し、術後リスク予測につなげています。`);
    }

    if (missedHigh.length > 0) {
      furtherPoints.push(`未選択だった【${missedHigh.map(id => itemMap[id]).join('、')}】も、術後の換気低下・排痰困難・無気肺を予測するうえで重要な根拠となります。`);
    }
    if (selectedSupp.length > 0) {
      furtherPoints.push(`選択した【${selectedSupp.map(id => itemMap[id]).join('、')}】は患者の全体像や退院支援を考えるうえでは有用ですが、「術後の呼吸状態を予測する」という今回の目的においては、喫煙歴・FEV₁/FVC・術式・分離肺換気などの呼吸器関連情報の優先度がより高くなります。`);
    }
    if (rationaleEval.matchedElements.length > 0) {
      strengths.push(`自由記述において「${rationaleEval.matchedElements.join('」「')}」の視点が含まれています。`);
    }
    if (rationaleEval.missingHints.length > 0) {
      furtherPoints.push(...rationaleEval.missingHints.map(h => `自由記述でさらに補うとよい視点：${h}`));
    }

    const isSufficient = selectedHigh.length >= 5 && (rationaleEval.levelCode === 'LEVEL_3' || rationaleEval.levelCode === 'LEVEL_4');

    return {
      patientOutcome: 'STABLE',
      clinicalReasoning: isSufficient ? 'SUFFICIENT_ASSESSMENT' : 'PARTIAL_ASSESSMENT',
      resultType: isSufficient ? 'Integrated preoperative respiratory assessment' : 'Developing preoperative respiratory assessment',
      title: isSufficient
        ? '患者背景と手術・麻酔要因を関連づけた術前呼吸機能アセスメント'
        : '術前呼吸機能アセスメントの完了（重要情報の関連づけをさらに深めましょう）',
      story: `あなたたちは${selectedInfo.length}個の患者情報カードを選択してそれぞれの意味づけを確認し、術後に予測されるAさんの呼吸状態についてアセスメント文章を作成しました。\n\n${rationaleEval.feedback}\n${rationaleEval.formativeNote}`,
      strengths,
      furtherPoints,
      modelThinking: '【教員用の模範的な思考例】\nAさんは安静時のSpO₂（97％・室内気）は保たれているが、68歳という年齢に加え、20本/日×45年間の喫煙歴、朝の喀痰、坂道での軽度の息切れがあり、FEV₁/FVC 64％から気流閉塞および線毛クリアランス低下が疑われる。\nここに全身麻酔・分離肺換気下での胸腔鏡下左上葉切除術が加わることで、肺容量の減少や肺胞の再拡張不全が生じやすく、さらに術後疼痛によって深呼吸や有効な咳嗽が抑制される可能性が高い。\nしたがって、術後は気道分泌物の貯留、肺胞換気量の低下、無気肺、低酸素血症などの発生リスクが高いと予測される。',
      reflectionQuestion: '選択した患者情報のうち、「患者側の呼吸器背景（喫煙・喀痰・FEV₁/FVC 64％など）」と「手術・麻酔・疼痛の要因」が術後にどう重なり合うか、グループで文章を比較してみましょう。',
      rationaleEvaluation: rationaleEval
    };
  }

  // ================= SCENE 2：AFTER（術直後の呼吸状態） =================
  if (sid === '2') {
    const coreIds = ['resp_depth_pattern', 'consciousness_sedation', 'pain_postop', 'breath_sounds_postop', 'analgesics_anesthetics', 'etco2_abg'];
    const lowPriorityIds = ['urine_output', 'wound_condition', 'body_temperature', 'diet_status', 'living_background_s2'];

    const selectedCore = selectedInfo.filter(id => coreIds.includes(id));
    const missedCore = coreIds.filter(id => !selectedInfo.includes(id));
    const selectedLow = selectedInfo.filter(id => lowPriorityIds.includes(id));

    const itemMap = {};
    (sceneDef?.infoItems || []).forEach(it => { itemMap[it.id] = it.label; });

    const strengths = [];
    const furtherPoints = [];

    if (selectedCore.length >= 4) {
      strengths.push(`呼吸状態のアセスメントに優先度の高い観察項目（${selectedCore.map(id => itemMap[id]).join('、')}）を的確に選択・確認できています。`);
    }
    if (missedCore.length > 0) {
      furtherPoints.push(`未確認だった【${missedCore.map(id => itemMap[id]).join('、')}】も、換気低下や呼吸抑制・無気肺を評価するうえで非常に優先度の高い情報です。`);
    }
    if (selectedLow.length > 0) {
      furtherPoints.push(`確認した【${selectedLow.map(id => itemMap[id]).join('、')}】は術後全身管理としては意味がありますが、「呼吸数9回/分・傾眠傾向」という緊急性の高い換気低下のアセスメントにおいては、呼吸の深さ・意識・呼吸音・麻酔鎮痛薬・EtCO₂/血液ガスの優先度がより高くなります。`);
    }

    const modelThinking = '【教員用の模範的な思考例】\n・呼吸数9回/分と「浅くゆっくりした呼吸」から、1回換気量および分時換気量・肺胞換気量の低下を強く疑う。\n・酸素3L/分投与中のためSpO₂は96％に保たれているが、酸素投与下のSpO₂のみでは十分に換気（CO₂排出）ができているとは判断できない。\n・全身麻酔直後であることやオピオイドを含むPCA使用、刺激がないと眠る傾眠傾向から、麻酔薬・オピオイド等による呼吸抑制（および低酸素・高CO₂換気応答の抑制）の可能性を考える（※機序は断定せず可能性として評価する）。\n・両側背側肺底部の呼吸音減弱や強い疼痛（安静時NRS 5・咳嗽時NRS 8）による浅呼吸から、背側無気肺の関与も考慮する。\n・CO₂蓄積（高二酸化炭素血症）やさらなる呼吸停止・悪化のリスクがあるため、速やかな声かけ・安全確認・再評価（EtCO₂や血液ガス検討を含む）と医師への報告・対応につなげる。';

    if (decision === 'recognize-hypoventilation-report') {
      strengths.push('酸素投与中のSpO₂ 96％だけに惑わされず、呼吸数9回/分・浅呼吸・傾眠傾向から換気低下（呼吸抑制疑い）を捉え、速やかな安全確認と医師への報告を選択できました。');
      if (rationaleEval.matchedElements.length > 0) {
        strengths.push(`自由記述において「${rationaleEval.matchedElements.join('」「')}」を説明できています。`);
      }
      if (rationaleEval.missingHints.length > 0) {
        furtherPoints.push(...rationaleEval.missingHints.map(h => `自由記述でさらに補うとよい視点：${h}`));
      }

      return {
        patientOutcome: 'STABLE',
        clinicalReasoning: selectedCore.length >= 4 ? 'SUFFICIENT_ASSESSMENT' : 'PARTIAL_ASSESSMENT',
        resultType: 'Appropriate recognition of hypoventilation and prompt safety action',
        title: '酸素化と換気の違いを踏まえた換気低下（呼吸抑制疑い）の把握と迅速な報告',
        story: `あなたたちは、酸素3L/分投与下でSpO₂が96％であっても、呼吸数9回/分・浅くゆっくりした呼吸・傾眠傾向から「肺胞換気量の低下（呼吸抑制の疑い）」があると判断し、速やかに安全確認・再評価と医師への報告を行いました。\n医師によりオピオイドPCA設定の調整と換気状態（血液ガス・EtCO₂）の評価が行われ、CO₂ナルコーシスや呼吸停止への進行を未然に防ぐことができました。\n\n${rationaleEval.feedback}\n${rationaleEval.formativeNote}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: 'なぜ「酸素3L/分投与中でSpO₂ 96％」であっても、換気（CO₂の排出）が十分とは言えないのでしょうか？SCENE 1の術前予測とも比較しながら振り返ってみましょう。',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'rely-on-spo2-96') {
      furtherPoints.push('酸素投与下では肺胞換気量が低下していてもSpO₂が高く保たれることがあるため、「SpO₂ 96％＝呼吸状態に問題なし」と判断すると呼吸抑制やCO₂蓄積を見落とす危険があります。');
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'MISSED_CRITICAL_CUE',
        resultType: 'Misinterpreting SpO2 96% under oxygen as adequate ventilation',
        title: 'PATIENT CONDITION CHANGED（SpO₂ 96％への過信による換気低下・CO₂貯留の進行）',
        story: `「SpO₂が96％あるから呼吸は大丈夫だろう」と判断してそのまま眠らせ続けた結果、浅くゆっくりした呼吸（9回/分→6回/分）がさらに進行し、CO₂蓄積（高二酸化炭素血症）によって呼びかけにも反応しにくい状態へと悪化しました。\n酸素投与中のSpO₂は「酸素化」の指標であり、「換気（分時換気量・CO₂排出）」が十分である証拠にはなりません。\n\n${rationaleEval.feedback}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '酸素投与中にSpO₂が96％保たれていても、呼吸数9回/分・浅呼吸の患者体内で二酸化炭素（CO₂）はどう変化しているでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      furtherPoints.push('呼吸数9回/分・傾眠傾向がある状態での独断によるオピオイド追加や突然の酸素中止は重篤な危険を伴います。まず気道・呼吸の安全確認と医師への報告・相談が必要です。');
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Unsafe intervention under suspected respiratory depression',
        title: 'PATIENT CONDITION CHANGED（呼吸抑制疑い下での不適切な対応による悪化）',
        story: `呼吸数9回/分・傾眠傾向という呼吸抑制の徴候があるにもかかわらず、オピオイドの追加投与（または独断での酸素中止）を行った結果、呼吸状態が急速に悪化し緊急対応が必要となりました。\n呼吸抑制が疑われる場面では、速やかな呼吸状態の再評価と医師への報告・相談が最優先です。\n\n${rationaleEval.feedback}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '強い創部痛（咳嗽時NRS 8）と呼吸抑制疑い（呼吸数9回/分・傾眠）が同時に存在するとき、看護師はどのように評価・報告すべきでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    }
  }

  // ================= SCENE 3：AFTER 2（胸腔ドレーンのアセスメント・複数選択式） =================
  if (sid === '3') {
    const correctIds = sceneDef?.correctDecisions || ['A', 'B', 'D', 'F'];
    const chosen = Array.isArray(selectedDecisions) && selectedDecisions.length > 0
      ? selectedDecisions
      : (decision ? String(decision).split(',').map(s => s.trim()).filter(Boolean) : []);

    const optionEvaluations = (sceneDef?.decisions || []).map(opt => {
      const isSelected = chosen.includes(opt.id);
      const isCorrectOption = !!opt.isCorrect;
      const isAppropriateChoice = (isSelected && isCorrectOption) || (!isSelected && !isCorrectOption);
      return {
        id: opt.id,
        label: opt.label,
        isSelected,
        isCorrectOption,
        isAppropriateChoice,
        statusLabel: isSelected
          ? (isCorrectOption ? '✓ 正しく選択（正答）' : '✕ 誤って選択（誤答）')
          : (isCorrectOption ? '△ 選択漏れ（正答を見落とし）' : '✓ 正しく非選択（誤答を回避）'),
        explanation: opt.explanation
      };
    });

    const isPerfect = optionEvaluations.every(o => o.isAppropriateChoice);
    const chosenCorrect = optionEvaluations.filter(o => o.isSelected && o.isCorrectOption);
    const missedCorrect = optionEvaluations.filter(o => !o.isSelected && o.isCorrectOption);
    const chosenWrong = optionEvaluations.filter(o => o.isSelected && !o.isCorrectOption);

    const strengths = [];
    const furtherPoints = [];

    if (chosenCorrect.length > 0) {
      strengths.push(`正答である【${chosenCorrect.map(o => o.id).join('・')}】を適切に選択できました。`);
    }
    if (!chosen.includes('E')) {
      strengths.push('「E（エアリーク時のドレーンクランプ）」という危険な誤答を選択せず回避できました。');
    }
    if (!chosen.includes('C')) {
      strengths.push('「C（排液所見のみから今後の出血リスク完全消失を断定）」という単一所見からの断定を回避できました。');
    }

    if (missedCorrect.length > 0) {
      furtherPoints.push(`正答である【${missedCorrect.map(o => o.id).join('・')}】が未選択でした。呼吸性移動の意味や、排液・エアリークの継続評価の必要性も合わせて確認しましょう。`);
    }
    if (chosenWrong.length > 0) {
      chosenWrong.forEach(w => {
        furtherPoints.push(`【${w.id}を選択した点について】${w.explanation}`);
      });
    }

    const modelThinking = '【教員用の模範的な思考例（正答：A・B・D・F）】\n・エアリークと肺再膨張（A）：咳嗽時のみ少量のエアリークは軽度の肺瘻や胸腔内残存空気の排出が考えられるが、皮下気腫がなく胸部X線で残存左肺が概ね再膨張し大量気胸もないため、現時点でドレーン排気は有効に機能している。\n・呼吸性移動（B）：水封室の呼吸性移動は、胸腔内圧の変化が伝わっておりドレーンが閉塞していないことを意味する。\n・排液所見から判断できることとできないこと（Cは誤り、Dが正答）：淡血性・2時間80mL・急増なしから「現時点で明らかな大量出血の徴候はない」と判断できるが、「出血リスクが完全にゼロで観察不要」とは断定できず、継続観察が必要である。\n・ドレーンクランプの危険性と継続評価（Eは誤り、Fが正答）：エアリークがある状態でドレーンをクランプすると「緊張性気胸」を招く危険があるため禁忌であり、水封管理を続けながらエアリークや皮下気腫の推移を継続評価する。';

    let outcome = 'STABLE';
    let reasoning = 'SUFFICIENT_ASSESSMENT';
    let title = '胸腔ドレーン複数所見の的確な統合アセスメント（完全正答：A・B・D・F）';
    let story = 'あなたたちは8つの観察所見を統合し、「判断できること」と「単一所見からは断定できず継続評価が必要なこと」、そして「安易なドレーンクランプの危険性」をすべて正確に区別してアセスメントできました。';

    if (!isPerfect) {
      if (chosen.includes('E')) {
        outcome = 'DETERIORATED';
        reasoning = 'INAPPROPRIATE_DECISION';
        title = '要注意：エアリーク存在下でのドレーンクランプ（E）は緊張性気胸の危険があります';
        story = '咳嗽時にエアリークがある状態で胸腔ドレーンをクランプ（閉塞）すると、肺から漏れた空気が胸腔内に逃げ場を失って貯留し、胸腔内圧が急上昇して「緊張性気胸」を引き起こす危険があります。各選択肢の解説を確認し、なぜA・B・D・Fが正答となるかを振り返りましょう。';
      } else {
        outcome = 'STABLE';
        reasoning = 'PARTIAL_ASSESSMENT';
        title = `胸腔ドレーンアセスメント結果（あなたたちの選択：${chosen.join('・') || 'なし'} ／ 正答：A・B・D・F）`;
        story = '胸腔ドレーンの所見は、1つの所見だけで「すべて安全」または「直ちに異常」と断定するのではなく、エアリーク・呼吸性移動・排液・皮下気腫・胸部X線を組み合わせて評価します。下の選択肢別フィードバックで各判断の根拠を確認しましょう。';
      }
    }

    return {
      patientOutcome: outcome,
      clinicalReasoning: reasoning,
      resultType: isPerfect ? 'Perfect multi-select drain assessment' : 'Partial multi-select drain assessment',
      title,
      story,
      strengths,
      furtherPoints,
      modelThinking,
      optionEvaluations,
      reflectionQuestion: '「排液は淡血性、術後2時間で80mL、急増なし」という所見から【判断できること】と【これだけでは判断できないこと】は何でしょうか？また、なぜエアリークがあるときにクランプしてはいけないのでしょうか？',
      rationaleEvaluation: rationaleEval
    };
  }

  // ================= SCENE 4：NEXT（初回離床の看護判断） =================
  if (sid === '4') {
    const allInfoIds = ['resp_circ_stability', 'orthostatic_symptom_bp', 'movement_pain_control', 'drain_route_status', 'patient_reason_refusal'];
    const checkedCount = selectedInfo.filter(id => allInfoIds.includes(id)).length;
    const missedIds = allInfoIds.filter(id => !selectedInfo.includes(id));

    const itemMap = {};
    (sceneDef?.infoItems || []).forEach(it => { itemMap[it.id] = it.label; });

    const strengths = [];
    const furtherPoints = [];

    if (checkedCount === 5) {
      strengths.push('初回離床の判断に必要な5つの重要情報（呼吸・循環動態、起立時のめまい・血圧変化、体動時疼痛、ドレーン・ルート類、離床を希望しない理由）をすべて確認できました。');
    } else if (checkedCount >= 3) {
      strengths.push(`離床判断のための重要情報（${selectedInfo.map(id => itemMap[id]).join('、')}）を確認できました。`);
    }
    if (missedIds.length > 0) {
      furtherPoints.push(`離床前に【${missedIds.map(id => itemMap[id]).join('、')}】もあわせて確認しておくと、安全性と患者理解がより確実になります。`);
    }

    const modelThinking = '【教員用の模範的な思考例】\n1. 安全性の評価：意識清明、呼吸数17回/分、SpO₂ 96％（室内気）、血圧128/76mmHg、脈拍86回/分（整）であり、昨日の呼吸抑制から回復して離床を検討できる状態にある。\n2. 阻害要因と患者の思いの理解：体動時NRS 5の痛みと「胸腔ドレーンが引っ張られないか」という不安から、Aさんは「今日はやめておきたい」と話している。\n3. 看護判断と声かけ：痛みや不安をまず受け止めたうえで、早期離床の目的（肺の再膨張・排痰促進・無気肺や肺炎の予防）を説明し、追加鎮痛薬の使用・創部保護（スプリンティング）・ドレーン保持・めまいや血圧確認といった具体的な援助を提案する。いきなり歩行を強制せず、Aさんの同意を得ながらまずはギャッジアップや端座位など段階的な離床を提案する（拒否が続く場合は無理に強制しない）。';

    if (decision === 'empathetic-stepwise-mobilization') {
      strengths.push('患者の意思と痛みに配慮しながら、疼痛緩和・目的説明・段階的な離床を提案する最も適切な看護判断（A）を選択できました。');
      if (rationaleEval.matchedElements.length > 0) {
        strengths.push(`声かけ記述において「${rationaleEval.matchedElements.join('」「')}」が表現されています。`);
      }
      if (rationaleEval.missingHints.length > 0) {
        furtherPoints.push(...rationaleEval.missingHints.map(h => `声かけ記述でさらに補うとよい視点：${h}`));
      }

      return {
        patientOutcome: 'STABLE',
        clinicalReasoning: (checkedCount >= 4 && (rationaleEval.levelCode === 'LEVEL_3' || rationaleEval.levelCode === 'LEVEL_4')) ? 'SUFFICIENT_ASSESSMENT' : 'APPROPRIATE_DECISION',
        resultType: 'Patient-centered safe stepwise mobilization',
        title: '安全性と患者の意思を尊重した段階的離床の提案と教育的声かけ',
        story: `あなたたちはAさんの「動くと少し痛いので、今日はやめておきたいです」という訴えを丁寧に受け止め、体動時疼痛（NRS 5）への鎮痛対応と創部・ドレーンの保護を提案しながら、早期離床の目的を分かりやすく説明しました。\n\nAさんは「いきなり歩かされるわけじゃなくて、痛み止めを使ってまずはベッドを起こして座るところからならやってみようかな」と納得され、めまいや血圧低下・SpO₂低下なく安全に端座位をとることができました。\n\n${rationaleEval.feedback}\n${rationaleEval.formativeNote}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '自分たちが記述した「Aさんへの声かけ」に、①痛みや不安の受け止め、②早期離床の目的、③具体的な安全援助、④同意を得ながらの段階的提案が含まれているか、グループ間で共有してみましょう。',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'force-standing-immediately') {
      furtherPoints.push('早期離床は必要ですが、患者の痛み（体動時NRS 5）や拒否の意思を無視して歩行を強制することは、苦痛の増強や信頼関係の破綻、起立性低血圧・転倒リスクを招きます。');
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Forced mobilization disregarding patient pain and autonomy',
        title: 'PATIENT CONDITION CHANGED（患者の意思・疼痛を無視した離床強制による苦痛増強）',
        story: `痛みを訴えて離床をためらうAさんに対し、十分な鎮痛や段階的な提案を行わずに歩行を強行しようとしたため、Aさんは強い創部痛とめまいを訴え、離床への拒否感がさらに強まってしまいました。\n早期離床の必要性と、患者の意思尊重・疼痛緩和・段階的な安全確認を両立させる関わりが求められます。\n\n${rationaleEval.feedback}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '患者が「痛いからやめておきたい」と話したとき、強制するのでも単純に諦めるのでもなく、看護師としてどのような提案ができるでしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else if (decision === 'accept-bedrest-no-explanation') {
      furtherPoints.push('患者の言葉をそのまま受け入れて終日安静にするだけでは、なぜ離床を希望しないのか（痛み・ドレーン不安）の解決や、無気肺・肺炎予防という看護の専門的支援につながりません。');
      return {
        patientOutcome: 'CONDITION_CHANGED',
        clinicalReasoning: 'PARTIAL_ASSESSMENT',
        resultType: 'Passive bedrest without pain relief or education',
        title: 'PATIENT CONDITION CHANGED（理由の傾聴・疼痛緩和・目的説明の不足による離床機会の喪失）',
        story: `Aさんの「今日はやめておきたい」という言葉に対し、痛みの緩和策や早期離床の目的、ベッドを少し起こすといった段階的な代替案を提示しないまま終日臥床としました。\n患者の意思を無理に曲げない姿勢は大切ですが、痛みや不安を和らげて「これならできるかもしれない」と患者自身が選択できるよう支援することが看護の役割です。\n\n${rationaleEval.feedback}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '「患者の意思を尊重すること」と「何も説明・援助せずに寝かせたままにすること」の違いは何でしょうか？',
        rationaleEvaluation: rationaleEval
      };
    } else {
      furtherPoints.push('術後初回離床では起立性低血圧・めまい・転倒や胸腔ドレーン牽引のリスクがあるため、患者一人で行わせず必ず看護師が付き添って段階的に評価します。');
      return {
        patientOutcome: 'DETERIORATED',
        clinicalReasoning: 'INAPPROPRIATE_DECISION',
        resultType: 'Unattended first mobilization risk',
        title: 'PATIENT CONDITION CHANGED（看護師の安全確認・付き添い欠如による転倒・ドレーン抜去リスク）',
        story: `鎮痛薬だけを渡してAさん一人で起き上がるよう伝えた結果、起き上がった際にめまい（起立性低血圧）とドレーンチューブの引っ張りが生じ、あわや転倒・ドレーン抜去となる危険な状況が生じました。\n術後初回離床では、必ず看護師が付き添い、バイタルサイン・めまい・ドレーン管理を行いながら段階的に進めます。\n\n${rationaleEval.feedback}`,
        strengths,
        furtherPoints,
        modelThinking,
        reflectionQuestion: '術後初回離床において、看護師がベッドサイドで直接確認・介助しなければならない安全上のポイントは何ですか？',
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
    strengths: [],
    furtherPoints: [],
    modelThinking: '',
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
      selectedDecisions: s.selectedDecisions || [],
      rationaleText: s.rationaleText,
      submittedAt: s.submittedAt,
      result: isReleased ? s.result : null,
      canonicalStory: isResolved ? scenarioData.scenes[String(i)]?.canonicalStory : null
    };
  }

  // BEFORE (Scene 1) と AFTER (Scene 2) の比較データ構築
  const s1 = groupState.scenes[1];
  const s2 = groupState.scenes[2];
  const s1Def = scenarioData.scenes['1'];
  const s1SelectedLabels = (s1?.selectedInfo || []).map(id => {
    const found = (s1Def?.infoItems || []).find(item => item.id === id);
    return found ? found.label : id;
  });

  const beforeAfterComparison = {
    beforeSelectedLabels: s1SelectedLabels,
    beforePredictionText: s1?.rationaleText || '（未入力）',
    afterActualVitals: '酸素3L/分（鼻カニューレ）、SpO₂ 96％、呼吸数 9回/分、浅くゆっくりした呼吸、傾眠傾向、安静時NRS 5・咳嗽時NRS 8、両側背側肺底部で呼吸音減弱（傍脊椎ブロック＋オピオイドPCA使用中）',
    afterAssessmentText: s2?.rationaleText || '（未入力）',
    comparisonPoint: '【比較の視点】術前に予測したリスク（気流閉塞・喫煙による排痰困難や麻酔・肺切除・疼痛による浅呼吸・無気肺リスク）に対し、術直後の実際では「酸素3L/分下でSpO₂ 96％は一見保たれているものの、麻酔薬・オピオイドの影響や疼痛も重なって呼吸数9回/分・浅呼吸・傾眠傾向という肺胞換気量の低下（呼吸抑制疑い）と背側呼吸音減弱」が出現しています。「SpO₂だけでは換気状態を評価できない」ことを術前予測と対比して確認しましょう。'
  };

  return {
    groupId: groupState.groupId,
    groupName: groupState.groupName,
    currentScene: currentSceneId,
    displayPhase,
    sceneStatus: globalSceneStatus,
    sceneStatuses: sceneStatuses,
    scenario: scenarioData,
    scenes: sanitizedScenes,
    beforeAfterComparison
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
      const itemMap = {};
      (sceneDef?.infoItems || []).forEach(it => { itemMap[it.id] = it.label; });

      let decisionLabel = '未決定';
      if (sceneDef?.questionType === 'multi_select') {
        decisionLabel = (currentSceneState.selectedDecisions && currentSceneState.selectedDecisions.length > 0)
          ? `選択：${currentSceneState.selectedDecisions.join('・')}`
          : '未選択';
      } else if (sceneDef?.questionType === 'free_text_only') {
        decisionLabel = currentSceneState.submittedAt ? 'カード選択＋自由記述提出済' : '作成中';
      } else {
        const decObj = (sceneDef?.decisions || []).find(d => d.id === currentSceneState.decision);
        decisionLabel = decObj
          ? decObj.label.slice(0, 28) + (decObj.label.length > 28 ? '…' : '')
          : (currentSceneState.decision || '未決定');
      }

      return {
        groupId: g.groupId,
        groupName: g.groupName,
        currentScene: g.currentScene,
        scenePhase: currentSceneState.phase,
        budgetUsed: currentSceneState.budget - currentSceneState.remainingBudget,
        budgetTotal: currentSceneState.budget,
        selectedInfo: currentSceneState.selectedInfo,
        selectedInfoLabels: currentSceneState.selectedInfo.map(id => itemMap[id] || id),
        decision: currentSceneState.decision,
        selectedDecisions: currentSceneState.selectedDecisions || [],
        decisionLabel,
        rationaleText: currentSceneState.rationaleText || '',
        rationaleLevel: currentSceneState.result?.rationaleEvaluation?.level || '未評価',
        rationaleLevelCode: currentSceneState.result?.rationaleEvaluation?.levelCode || 'NONE',
        resultType: currentSceneState.result?.resultType || '未判定',
        patientOutcome: currentSceneState.result?.patientOutcome || '未確定',
        clinicalReasoning: currentSceneState.result?.clinicalReasoning || '未確定',
        submittedAt: currentSceneState.submittedAt
      };
    }),
    debrief: {}
  };

  for (let i = 1; i <= 4; i++) {
    const sid = String(i);
    const sceneDef = scenarioData.scenes[sid];
    if (!sceneDef) continue;

    const itemMap = {};
    const infoCounts = {};
    (sceneDef.infoItems || []).forEach(item => {
      itemMap[item.id] = item.label;
      infoCounts[item.id] = {
        id: item.id,
        label: item.label,
        priorityLevel: item.priorityLevel || (item.isCritical ? 'high' : 'supplementary'),
        count: 0,
        percentage: 0
      };
    });

    const decisionCounts = {};
    (sceneDef.decisions || []).forEach(dec => {
      decisionCounts[dec.id] = {
        id: dec.id,
        label: dec.label,
        isCorrect: !!dec.isCorrect,
        count: 0,
        percentage: 0
      };
    });

    const outcomeCounts = {
      STABLE: 0,
      CONDITION_CHANGED: 0,
      DETERIORATED: 0
    };

    const reasoningCounts = {};
    const rationaleEntries = [];
    let totalSubmissionsInScene = 0;
    let exactMultiSelectMatches = 0;

    groupsList.forEach((g, idx) => {
      const s = g.scenes[i];
      if (s && s.submittedAt) {
        totalSubmissionsInScene++;
        s.selectedInfo.forEach(infoId => {
          if (infoCounts[infoId]) infoCounts[infoId].count++;
        });

        if (sceneDef.questionType === 'multi_select') {
          const chosen = Array.isArray(s.selectedDecisions) ? s.selectedDecisions : [];
          chosen.forEach(dId => {
            if (decisionCounts[dId]) decisionCounts[dId].count++;
          });
          const correctSet = new Set(sceneDef.correctDecisions || ['A', 'B', 'D', 'F']);
          if (chosen.length === correctSet.size && chosen.every(c => correctSet.has(c))) {
            exactMultiSelectMatches++;
          }
        } else {
          if (s.decision && decisionCounts[s.decision]) {
            decisionCounts[s.decision].count++;
          }
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

        let shortDec = '';
        if (sceneDef.questionType === 'multi_select') {
          shortDec = `選択：${(s.selectedDecisions || []).join('・') || 'なし'}`;
        } else if (sceneDef.questionType === 'free_text_only') {
          shortDec = `選択カード数：${s.selectedInfo.length}枚`;
        } else {
          const decObj = (sceneDef.decisions || []).find(d => d.id === s.decision);
          shortDec = decObj ? decObj.label.slice(0, 30) + (decObj.label.length > 30 ? '…' : '') : (s.decision || '');
        }

        rationaleEntries.push({
          groupId: g.groupId,
          groupName: g.groupName,
          anonymousLabel: `グループ ${String.fromCharCode(65 + (idx % 26))}`,
          decisionId: s.decision,
          selectedDecisions: s.selectedDecisions || [],
          decisionShort: shortDec,
          selectedInfoLabels: s.selectedInfo.map(id => itemMap[id] || id),
          beforePredictionText: g.scenes[1]?.rationaleText || '',
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
      stepLabel: sceneDef.stepLabel,
      questionType: sceneDef.questionType,
      clinicalQuestion: sceneDef.clinicalQuestion,
      debriefFocus: sceneDef.debriefFocus,
      debriefQuestions: sceneDef.debriefQuestions || [],
      rationalePrompt: sceneDef.rationalePrompt || '',
      correctDecisions: sceneDef.correctDecisions || [],
      exactMultiSelectMatches,
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
      return socket.emit('error-msg', { message: 'すでに回答を送信済みです' });
    }
    if (sceneState.remainingBudget <= 0) {
      return socket.emit('error-msg', { message: 'これ以上カードを選択できません' });
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
    const { groupId, sceneId, decisionId, selectedDecisions, rationaleText } = data || {};
    if (!groups.has(groupId)) return;

    const groupState = groups.get(groupId);
    const sid = parseInt(sceneId);

    if (sceneStatuses[sid] !== 'ACTIVE') {
      return socket.emit('error-msg', { message: 'このSceneは現在送信を受け付けていません' });
    }

    const sceneState = groupState.scenes[sid];
    if (sceneState.phase !== 'assessment') {
      return socket.emit('error-msg', { message: 'すでに送信済みです（回答確定後は変更できません）' });
    }

    const sceneDef = scenarioData.scenes[String(sid)];
    const qType = sceneDef?.questionType || 'single_select_and_free_text';
    const minLen = sceneDef?.rationaleMinLength ?? 50;
    const maxLen = sceneDef?.rationaleMaxLength ?? 400;
    const cleanedRationale = (rationaleText || '').trim();

    let finalDecisionId = decisionId || null;
    let finalSelectedDecisions = Array.isArray(selectedDecisions) ? selectedDecisions : [];

    if (qType === 'multi_select') {
      if (finalSelectedDecisions.length === 0 && finalDecisionId) {
        finalSelectedDecisions = String(finalDecisionId).split(',').map(s => s.trim()).filter(Boolean);
      }
      if (finalSelectedDecisions.length === 0) {
        return socket.emit('error-msg', { message: '正しいと考えるアセスメントを1つ以上選択してください' });
      }
      finalSelectedDecisions.sort();
      finalDecisionId = finalSelectedDecisions.join(',');
    } else if (qType === 'free_text_only') {
      if (sceneState.selectedInfo.length === 0) {
        return socket.emit('error-msg', { message: 'アセスメントに重要な患者情報カードを1枚以上選択してください' });
      }
      finalDecisionId = finalDecisionId || 'preop-assessment-complete';
    } else {
      if (!finalDecisionId) {
        return socket.emit('error-msg', { message: '看護判断の選択肢（A〜D）を選択してください' });
      }
    }

    if (minLen > 0 && cleanedRationale.length < minLen) {
      return socket.emit('error-msg', { message: `自由記述を${minLen}文字以上で入力してください（現在${cleanedRationale.length}文字）` });
    }
    if (cleanedRationale.length > maxLen) {
      return socket.emit('error-msg', { message: `自由記述は${maxLen}文字以内で入力してください` });
    }

    sceneState.decision = finalDecisionId;
    sceneState.selectedDecisions = finalSelectedDecisions;
    sceneState.rationaleText = cleanedRationale;
    sceneState.submittedAt = new Date().toISOString();
    sceneState.phase = 'submitted';

    // 内部で事前にResultを算出・記録（学生にはRESULTS_RELEASEDまで非公開）
    sceneState.result = evaluateSceneResult(sid, sceneState.selectedInfo, finalDecisionId, cleanedRationale, finalSelectedDecisions);

    socket.emit('game-state-updated', buildClientPayload(groupState));
    io.emit('admin-summary-updated', buildAdminSummary());
    console.log(`[Student] Submitted by ${groupState.groupName} for Scene ${sid}: decision=${finalDecisionId} (${cleanedRationale.length} chars)`);
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
        const defaultDec = scenarioData.scenes[String(sid)]?.decisions?.[0]?.id || 'preop-assessment-complete';
        s.result = evaluateSceneResult(sid, s.selectedInfo, s.decision || defaultDec, s.rationaleText || '', s.selectedDecisions || []);
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
