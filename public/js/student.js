(function() {
  'use strict';

  let socket;
  let groupId = localStorage.getItem('lcs_group_id');
  let groupName = localStorage.getItem('lcs_group_name');
  let payload = null; // サーバーからの最新データ

  let selectedDecisionId = null;
  let selectedMultiDecisions = []; // Scene 3 (AFTER 2) 複数選択用
  let lastRenderedSceneId = null;
  let manualDecisionOpen = false;
  const draftRationales = {}; // Sceneごとの入力中テキスト保持（再描画時消失防止）
  const draftMultiDecisions = {}; // Scene 3 の選択中チェック保持
  const shuffledItemIdsByScene = {}; // Sceneごとのカード表示順保持（重要な情報と優先度の低い情報をランダム混在表示）

  function getDisplayInfoItems(sceneDef, sceneId) {
    const items = sceneDef?.infoItems || [];
    if (!sceneDef?.shuffleItems || items.length <= 1) {
      return items;
    }
    const storageKey = `lcs_shuffled_scene_${sceneId}`;
    let order = shuffledItemIdsByScene[sceneId];
    if (!order) {
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) order = JSON.parse(saved);
      } catch (e) {}
    }
    const currentIds = items.map(it => it.id);
    if (!Array.isArray(order) || order.length !== currentIds.length || !currentIds.every(id => order.includes(id))) {
      // Fisher-Yates シャッフルで重要な情報と優先度の低い情報をランダムに混在させる
      order = [...currentIds];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      shuffledItemIdsByScene[sceneId] = order;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(order));
      } catch (e) {}
    } else {
      shuffledItemIdsByScene[sceneId] = order;
    }
    const itemMap = {};
    items.forEach(it => { itemMap[it.id] = it; });
    return order.map(id => itemMap[id]).filter(Boolean);
  }

  // 患者アバターSVG（肺がん周術期看護仕様）
  const avatars = {
    'resting': `<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="35" r="20" fill="#5a6c7d"/>
      <circle cx="53" cy="32" r="2" fill="white"/>
      <circle cx="67" cy="32" r="2" fill="white"/>
      <path d="M 54 42 Q 60 46 66 42" stroke="white" stroke-width="1.5" fill="none"/>
      <rect x="40" y="60" width="40" height="55" rx="8" fill="#4A90D9"/>
      <rect x="30" y="110" width="25" height="8" rx="4" fill="#5a6c7d"/>
      <rect x="65" y="110" width="25" height="8" rx="4" fill="#5a6c7d"/>
      <line x1="35" y1="68" x2="20" y2="85" stroke="#5a6c7d" stroke-width="6" stroke-linecap="round"/>
      <line x1="85" y1="68" x2="100" y2="85" stroke="#5a6c7d" stroke-width="6" stroke-linecap="round"/>
      <text x="60" y="150" text-anchor="middle" font-size="11" font-weight="bold" fill="#5a6c7d">術前・安静時</text>
    </svg>`,
    'discomfort': `<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="35" r="20" fill="#b7791f"/>
      <line x1="50" y1="32" x2="56" y2="32" stroke="white" stroke-width="2" stroke-linecap="round"/>
      <line x1="64" y1="32" x2="70" y2="32" stroke="white" stroke-width="2" stroke-linecap="round"/>
      <path d="M 55 43 Q 60 40 65 43" stroke="white" stroke-width="1.5" fill="none"/>
      <rect x="40" y="60" width="40" height="55" rx="8" fill="#4A90D9"/>
      <line x1="40" y1="68" x2="54" y2="82" stroke="#b7791f" stroke-width="6" stroke-linecap="round"/>
      <circle cx="66" cy="80" r="7" fill="#f56565" opacity="0.65"/>
      <line x1="80" y1="68" x2="68" y2="82" stroke="#b7791f" stroke-width="6" stroke-linecap="round"/>
      <rect x="30" y="110" width="25" height="8" rx="4" fill="#b7791f"/>
      <rect x="65" y="110" width="25" height="8" rx="4" fill="#b7791f"/>
      <text x="60" y="150" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#b7791f">抜管帰室30分・傾眠/浅呼吸</text>
    </svg>`,
    'resting-after': `<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="35" r="20" fill="#2b6cb0"/>
      <circle cx="53" cy="32" r="2" fill="white"/>
      <circle cx="67" cy="32" r="2" fill="white"/>
      <path d="M 54 42 Q 60 40 66 42" stroke="white" stroke-width="1.5" fill="none"/>
      <rect x="40" y="60" width="40" height="55" rx="8" fill="#4A90D9"/>
      <rect x="30" y="110" width="25" height="8" rx="4" fill="#2b6cb0"/>
      <rect x="65" y="110" width="25" height="8" rx="4" fill="#2b6cb0"/>
      <line x1="35" y1="68" x2="22" y2="88" stroke="#2b6cb0" stroke-width="6" stroke-linecap="round"/>
      <line x1="85" y1="68" x2="98" y2="88" stroke="#2b6cb0" stroke-width="6" stroke-linecap="round"/>
      <text x="60" y="150" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#2b6cb0">術後管理・ドレーン/離床</text>
    </svg>`
  };

  function getAvatar(state) {
    return avatars[state] || avatars['resting'];
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
  }

  function showToast(message) {
    const toast = document.getElementById('toast-notification');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // 初期化
  function init() {
    socket = io();
    setupSocketListeners();
    setupEventListeners();

    if (groupId) {
      socket.emit('rejoin-group', { groupId });
    }
  }

  // Socket受信リスナー
  function setupSocketListeners() {
    socket.on('connect', () => {
      if (groupId) {
        socket.emit('rejoin-group', { groupId });
      }
    });

    socket.on('registered', (data) => {
      payload = data;
      groupId = data.groupId;
      groupName = data.groupName;
      localStorage.setItem('lcs_group_id', groupId);
      localStorage.setItem('lcs_group_name', groupName);
      window.scrollTo(0, 0);
      render();
    });

    socket.on('rejoined', (data) => {
      payload = data;
      groupId = data.groupId;
      groupName = data.groupName;
      render();
    });

    socket.on('rejoin-failed', () => {
      localStorage.removeItem('lcs_group_id');
      localStorage.removeItem('lcs_group_name');
      groupId = null;
      groupName = null;
      showScreen('screen-register');
    });

    socket.on('game-state-updated', (data) => {
      const prevPhase = payload ? payload.displayPhase : null;
      const prevScene = payload ? payload.currentScene : null;
      payload = data;
      if (prevPhase !== data.displayPhase || prevScene !== data.currentScene) {
        window.scrollTo(0, 0);
      }
      render();
    });

    socket.on('error-msg', (data) => {
      showToast(data.message || 'エラーが発生しました');
    });

    socket.on('admin-reset-done', () => {
      localStorage.removeItem('lcs_group_id');
      localStorage.removeItem('lcs_group_name');
      groupId = null;
      groupName = null;
      payload = null;
      selectedDecisionId = null;
      selectedMultiDecisions = [];
      lastRenderedSceneId = null;
      manualDecisionOpen = false;
      Object.keys(draftRationales).forEach(k => delete draftRationales[k]);
      Object.keys(draftMultiDecisions).forEach(k => delete draftMultiDecisions[k]);
      Object.keys(shuffledItemIdsByScene).forEach(k => {
        delete shuffledItemIdsByScene[k];
        try { sessionStorage.removeItem(`lcs_shuffled_scene_${k}`); } catch (e) {}
      });
      showScreen('screen-register');
    });
  }

  function updateSubmitButtonState() {
    if (!payload) return;
    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const sceneState = payload.scenes[currentSid];
    const qType = sceneDef?.questionType || 'single_select_and_free_text';
    const minLen = sceneDef?.rationaleMinLength ?? 50;
    const maxLen = sceneDef?.rationaleMaxLength ?? 400;

    const rationaleEl = document.getElementById('student-rationale');
    const text = rationaleEl ? rationaleEl.value.trim() : '';
    const len = text.length;

    draftRationales[currentSid] = rationaleEl ? rationaleEl.value : '';

    const countEl = document.getElementById('rationale-char-count');
    const hintEl = document.getElementById('rationale-status-hint');
    if (countEl) {
      countEl.textContent = minLen > 0
        ? `${len} / ${maxLen} 文字（送信可能：${minLen}文字以上）`
        : `${len} / ${maxLen} 文字（任意記入）`;
    }

    let isChoiceValid = false;
    if (qType === 'multi_select') {
      isChoiceValid = selectedMultiDecisions.length > 0;
    } else if (qType === 'free_text_only') {
      isChoiceValid = sceneState.selectedInfo.length > 0;
    } else {
      isChoiceValid = !!selectedDecisionId;
    }

    const isTextValid = len >= minLen && len <= maxLen;

    if (hintEl) {
      if (qType === 'multi_select') {
        if (!isChoiceValid) {
          hintEl.textContent = '上の選択肢（A〜F）から正しいと思うものを1つ以上チェックしてください';
          hintEl.className = 'rationale-status-hint status-short';
        } else {
          hintEl.textContent = `✓ 現在 ${selectedMultiDecisions.join('・')} を選択中（送信可能です）`;
          hintEl.className = 'rationale-status-hint status-ready';
        }
      } else if (!isTextValid) {
        hintEl.textContent = `あと ${Math.max(0, minLen - len)} 文字以上で送信可能になります（${sceneDef.rationaleLengthGuide || ''}）`;
        hintEl.className = 'rationale-status-hint status-short';
      } else if (!isChoiceValid) {
        hintEl.textContent = qType === 'free_text_only'
          ? '上の患者情報カードを1枚以上選択してください'
          : '✓ 文字数OK（上の選択肢 A〜D を1つ選んでください）';
        hintEl.className = 'rationale-status-hint status-almost';
      } else {
        hintEl.textContent = '✓ 送信準備が整いました';
        hintEl.className = 'rationale-status-hint status-ready';
      }
    }

    const submitBtn = document.getElementById('btn-submit-decision');
    if (submitBtn) {
      submitBtn.disabled = !(isChoiceValid && isTextValid);
    }
  }

  // DOMイベントリスナー
  function setupEventListeners() {
    // 登録
    document.getElementById('btn-register').addEventListener('click', () => {
      const name = document.getElementById('group-name').value.trim();
      if (!name) {
        showToast('グループ名を入力してください');
        return;
      }
      socket.emit('register-group', { groupName: name });
    });

    document.getElementById('group-name').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-register').click();
    });

    // 判断へ進むボタン
    document.getElementById('btn-proceed-decision').addEventListener('click', () => {
      manualDecisionOpen = true;
      document.getElementById('proceed-btn-wrap').style.display = 'none';
      document.getElementById('decision-section').style.display = 'block';
      document.getElementById('decision-section').scrollIntoView({ behavior: 'smooth' });
    });

    // 自由記述入力リスナー
    const rationaleEl = document.getElementById('student-rationale');
    if (rationaleEl) {
      rationaleEl.addEventListener('input', updateSubmitButtonState);
    }

    // 送信確認モーダル
    document.getElementById('btn-submit-decision').addEventListener('click', () => {
      if (!payload) return;
      const currentSceneId = payload.currentScene;
      const sceneDef = payload.scenario.scenes[String(currentSceneId)];
      const sceneState = payload.scenes[currentSceneId];
      const qType = sceneDef?.questionType || 'single_select_and_free_text';
      const rationaleText = document.getElementById('student-rationale').value.trim();

      document.getElementById('confirm-title').textContent = sceneDef.confirmPrompt || 'この内容で回答を確定してよいですか？';

      const decBlock = document.getElementById('confirm-decision-block');
      const ratBlock = document.getElementById('confirm-rationale-block');

      if (qType === 'multi_select') {
        decBlock.style.display = 'block';
        const chosenLabels = (sceneDef.decisions || [])
          .filter(d => selectedMultiDecisions.includes(d.id))
          .map(d => `・${d.label}`)
          .join('\n');
        document.getElementById('confirm-detail').innerHTML = escapeHtml(chosenLabels).replace(/\n/g, '<br>');
        if (rationaleText) {
          ratBlock.style.display = 'block';
          document.getElementById('confirm-rationale-preview').textContent = rationaleText;
        } else {
          ratBlock.style.display = 'none';
        }
      } else if (qType === 'free_text_only') {
        decBlock.style.display = 'block';
        const chosenCards = (sceneDef.infoItems || [])
          .filter(i => sceneState.selectedInfo.includes(i.id))
          .map(i => i.label)
          .join('、');
        document.getElementById('confirm-detail').textContent = `選択した患者情報カード（${sceneState.selectedInfo.length}枚）：${chosenCards}`;
        ratBlock.style.display = 'block';
        document.getElementById('confirm-rationale-preview').textContent = rationaleText;
      } else {
        decBlock.style.display = 'block';
        const dec = (sceneDef.decisions || []).find(d => d.id === selectedDecisionId);
        document.getElementById('confirm-detail').textContent = dec ? `${dec.label}` : selectedDecisionId;
        ratBlock.style.display = 'block';
        document.getElementById('confirm-rationale-preview').textContent = rationaleText;
      }

      document.getElementById('confirm-modal').style.display = 'flex';
    });

    document.getElementById('btn-confirm-no').addEventListener('click', () => {
      document.getElementById('confirm-modal').style.display = 'none';
    });

    document.getElementById('btn-confirm-yes').addEventListener('click', () => {
      document.getElementById('confirm-modal').style.display = 'none';
      if (!payload) return;
      const currentSid = payload.currentScene;
      const sceneDef = payload.scenario.scenes[String(currentSid)];
      const qType = sceneDef?.questionType || 'single_select_and_free_text';
      const rationaleText = document.getElementById('student-rationale').value.trim();

      socket.emit('submit-decision', {
        groupId,
        sceneId: currentSid,
        decisionId: qType === 'free_text_only' ? 'preop-assessment-complete' : selectedDecisionId,
        selectedDecisions: qType === 'multi_select' ? selectedMultiDecisions : [],
        rationaleText
      });
    });
  }

  // メイン描画分岐
  function render() {
    if (!payload || !payload.scenario) {
      showScreen('screen-register');
      return;
    }

    // 患者紹介文のロード
    const summaryText = document.getElementById('patient-summary-text');
    if (summaryText && payload.scenario.patient) {
      const p = payload.scenario.patient;
      summaryText.innerHTML = `<strong>${escapeHtml(p.name)}（${p.age}歳・${escapeHtml(p.gender)}）</strong><br>
        診断名：${escapeHtml(p.diagnosis)} ／ 予定術式：${escapeHtml(p.treatment)}<br>
        背景・既往歴：${escapeHtml(p.history.join('、'))} ／ ${escapeHtml(p.family)}<br>
        概要：${escapeHtml(p.currentStatus)}<br>
        <small class="text-muted">${escapeHtml(p.disclaimer || '')}</small>`;
    }

    document.getElementById('group-name-display').textContent = payload.groupName;

    const displayPhase = payload.displayPhase;

    if (displayPhase === 'submitted') {
      showScreen('screen-wait');
    } else if (displayPhase === 'result') {
      renderResultScreen();
    } else if (displayPhase === 'resolved') {
      renderCanonicalScreen();
    } else {
      renderGameScreen();
    }
  }

  // STEP 2: ASSESSMENT & DECISION 画面の描画
  function renderGameScreen() {
    showScreen('screen-game');

    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const sceneState = payload.scenes[currentSid];
    const qType = sceneDef.questionType || 'single_select_and_free_text';

    // Sceneが切り替わった場合の初期化（同じScene内の再描画では入力中テキストを保持）
    if (lastRenderedSceneId !== currentSid) {
      lastRenderedSceneId = currentSid;
      selectedDecisionId = sceneState.decision || null;
      selectedMultiDecisions = (sceneState.selectedDecisions && sceneState.selectedDecisions.length > 0)
        ? [...sceneState.selectedDecisions]
        : (draftMultiDecisions[currentSid] ? [...draftMultiDecisions[currentSid]] : []);
      manualDecisionOpen = false;
      const rationaleEl = document.getElementById('student-rationale');
      if (rationaleEl) {
        rationaleEl.value = sceneState.rationaleText || draftRationales[currentSid] || '';
      }
    }

    // プログレスバー (BEFORE -> AFTER -> AFTER 2 -> NEXT)
    document.querySelectorAll('.progress-step').forEach(step => {
      const s = parseInt(step.dataset.scene);
      step.classList.remove('active', 'completed');
      if (s < currentSid) step.classList.add('completed');
      if (s === currentSid) step.classList.add('active');
    });

    // ヘッダー＆アバター
    document.getElementById('scene-title').textContent = sceneDef.title;
    document.getElementById('scene-subtitle').textContent = sceneDef.subtitle;
    document.getElementById('patient-avatar').innerHTML = getAvatar(sceneDef.patientState);

    // 発言
    const dialogueBox = document.getElementById('dialogue-content');
    dialogueBox.innerHTML = '';
    (sceneDef.dialogue || []).forEach(d => {
      dialogueBox.innerHTML += `
        <div class="speech-bubble">
          <div class="speech-speaker">${escapeHtml(payload.scenario.patient.name)}</div>
          <div class="speech-text">${escapeHtml(d.text)}</div>
        </div>
      `;
    });

    // 初期提示サマリー
    const initialSummary = document.getElementById('initial-summary-text');
    if (initialSummary) {
      if (sceneDef.initialInfo && sceneDef.initialInfo.summary) {
        initialSummary.style.display = 'block';
        initialSummary.innerHTML = escapeHtml(sceneDef.initialInfo.summary).replace(/\n/g, '<br>');
      } else {
        initialSummary.style.display = 'none';
      }
    }

    // 初期提示バイタルサイン・所見
    const vitalsList = document.getElementById('vitals-list');
    vitalsList.innerHTML = '';
    if (sceneDef.initialInfo && sceneDef.initialInfo.vitals) {
      sceneDef.initialInfo.vitals.forEach(v => {
        vitalsList.innerHTML += `
          <div class="vital-item">
            <span class="vital-label">${escapeHtml(v.label)}</span>
            <span class="vital-value">${escapeHtml(v.value)}</span>
          </div>
        `;
      });
    }

    // 指示文
    document.getElementById('instruction-box').innerHTML = escapeHtml(sceneDef.instruction).replace(/\n/g, '<br>');

    // Information Budget 表示（Scene 2の安全確保モード等に対応）
    renderBudget(sceneDef, sceneState.budget, sceneState.remainingBudget, sceneState.selectedInfo.length);

    // 情報選択肢カード一覧
    const infoHeading = document.getElementById('info-selection-heading');
    if (infoHeading) {
      if (currentSid === 1) infoHeading.textContent = '患者情報カード（全16項目から、術後の呼吸機能予測に重要な8項目を選択してください）';
      else if (currentSid === 2) infoHeading.textContent = '追加で観察・確認したい項目を選択してください（安全確認のため制限なく確認可能）';
      else if (currentSid === 3) infoHeading.textContent = '所見の解釈・基礎知識カード（必要に応じてクリックして確認できます）';
      else infoHeading.textContent = '初回離床を判断するために重要な情報を確認してください';
    }
    const displayInfoItems = getDisplayInfoItems(sceneDef, currentSid);
    renderInfoItems(displayInfoItems, sceneState.selectedInfo, sceneState.remainingBudget);

    // 取得済み情報と意味づけ解説の蓄積リスト
    renderCollectedInfo(sceneDef.infoItems, sceneState.selectedInfo, currentSid);

    // 判断＋自由記述セクション
    renderDecisionsAndRationale(sceneDef, currentSid);

    // 判断セクションの表示制御
    const proceedWrap = document.getElementById('proceed-btn-wrap');
    const decisionSection = document.getElementById('decision-section');
    if (qType === 'multi_select') {
      // Scene 3 (AFTER 2) は最初から複数選択セクションを表示
      proceedWrap.style.display = 'none';
      decisionSection.style.display = 'block';
    } else if (sceneState.remainingBudget === 0 || manualDecisionOpen || sceneState.selectedInfo.length >= 3) {
      proceedWrap.style.display = 'none';
      decisionSection.style.display = 'block';
    } else if (sceneState.selectedInfo.length > 0) {
      proceedWrap.style.display = 'block';
      decisionSection.style.display = 'none';
    } else {
      proceedWrap.style.display = 'none';
      decisionSection.style.display = 'none';
    }
  }

  function renderBudget(sceneDef, totalBudget, remaining, selectedCount) {
    const labelEl = document.getElementById('budget-label-title');
    const dotsEl = document.getElementById('budget-dots');
    const textEl = document.getElementById('budget-text');
    dotsEl.innerHTML = '';

    if (sceneDef.unlimitedSafetyMode) {
      labelEl.textContent = 'SAFETY & OBSERVATION';
      for (let i = 0; i < totalBudget; i++) {
        const dot = document.createElement('span');
        dot.className = `budget-dot ${i < selectedCount ? 'used' : 'available'}`;
        dotsEl.appendChild(dot);
      }
      textEl.textContent = `確認済み：${selectedCount} 項目（安全確保のため制限なく観察結果を確認できます）`;
      return;
    }

    labelEl.textContent = 'INFORMATION SELECTION';
    for (let i = 0; i < totalBudget; i++) {
      const dot = document.createElement('span');
      dot.className = `budget-dot ${i < remaining ? 'available' : 'used'}`;
      dotsEl.appendChild(dot);
    }
    textEl.textContent = `選択済み：${selectedCount} 枚（あと ${remaining} 枚まで選択できます）`;
    if (remaining === 0) {
      textEl.textContent = `上限まで選択しました。蓄積された解説を確認して下の回答欄へ進んでください。`;
    }
  }

  function renderInfoItems(infoItems, selectedIds, remainingBudget) {
    const container = document.getElementById('info-items');
    container.innerHTML = '';

    infoItems.forEach(item => {
      const isSelected = selectedIds.includes(item.id);
      const isBudgetZero = remainingBudget <= 0;

      const card = document.createElement('div');
      card.className = `info-card ${isSelected ? 'selected' : ''} ${!isSelected && isBudgetZero ? 'disabled' : ''}`;

      let priorityTagHtml = '';
      if (isSelected && item.priorityBadge) {
        const pClass = item.priorityLevel === 'high' ? 'priority-tag-high' : 'priority-tag-supp';
        priorityTagHtml = `<div class="info-priority-badge ${pClass}">${escapeHtml(item.priorityBadge)}</div>`;
      }

      if (isSelected) {
        card.innerHTML = `
          <div class="info-card-header">
            <span class="info-card-icon">${item.icon}</span>
            <span class="info-card-title">✓ ${escapeHtml(item.label)}</span>
          </div>
          ${priorityTagHtml}
          <div class="info-card-content">${escapeHtml(item.content).replace(/\n/g, '<br>')}</div>
        `;
      } else {
        card.innerHTML = `
          <div class="info-card-header">
            <span class="info-card-icon">${item.icon}</span>
            <span class="info-card-title">${escapeHtml(item.label)}</span>
          </div>
          <div class="info-card-hint">クリックして意味・結果を確認する</div>
        `;
        if (!isBudgetZero) {
          card.addEventListener('click', () => {
            socket.emit('select-info', {
              groupId,
              sceneId: payload.currentScene,
              infoId: item.id
            });
          });
        }
      }
      container.appendChild(card);
    });
  }

  function renderCollectedInfo(infoItems, selectedIds, currentSid) {
    const section = document.getElementById('collected-info-section');
    const heading = document.getElementById('collected-info-heading');
    const list = document.getElementById('collected-info-list');
    list.innerHTML = '';

    if (selectedIds.length === 0) {
      section.style.display = 'none';
      return;
    }

    if (heading) {
      if (currentSid === 1) {
        heading.textContent = `📌 選択した患者情報と意味づけの蓄積（${selectedIds.length}枚選択中 — これらを関連づけて記述しましょう）`;
      } else if (currentSid === 2) {
        heading.textContent = `📌 観察結果と病態生理上の意味（${selectedIds.length}項目確認済み）`;
      } else {
        heading.textContent = `📌 確認した情報一覧（${selectedIds.length}項目）`;
      }
    }

    section.style.display = 'block';
    selectedIds.forEach(id => {
      const item = infoItems.find(i => i.id === id);
      if (item) {
        const badgeHtml = item.priorityBadge
          ? `<span class="collected-priority-pill ${item.priorityLevel === 'high' ? 'pill-high' : 'pill-supp'}">${escapeHtml(item.priorityBadge)}</span>`
          : '';
        list.innerHTML += `
          <div class="collected-item">
            <div class="collected-item-label">${item.icon} ${escapeHtml(item.label)} ${badgeHtml}</div>
            <div class="collected-item-text">${escapeHtml(item.content).replace(/\n/g, '<br>')}</div>
          </div>
        `;
      }
    });
  }

  function renderDecisionsAndRationale(sceneDef, currentSid) {
    const qType = sceneDef.questionType || 'single_select_and_free_text';
    const choiceBlock = document.getElementById('decision-choice-block');
    const decisionStepBadge = document.getElementById('decision-step-badge');
    const rationaleCard = document.getElementById('rationale-input-card');
    const rationaleStepBadge = document.getElementById('rationale-step-badge');
    const rationalePromptEl = document.getElementById('rationale-prompt');
    const rationaleGuideEl = document.getElementById('rationale-length-guide');
    const rationaleEl = document.getElementById('student-rationale');
    const container = document.getElementById('decision-options');

    if (rationalePromptEl && sceneDef.rationalePrompt) {
      rationalePromptEl.textContent = sceneDef.rationalePrompt;
    }
    if (rationaleGuideEl) {
      rationaleGuideEl.textContent = sceneDef.rationaleLengthGuide || '';
    }
    if (rationaleEl && sceneDef.rationaleMaxLength) {
      rationaleEl.maxLength = sceneDef.rationaleMaxLength;
      rationaleEl.rows = qType === 'multi_select' ? 2 : 5;
    }

    container.innerHTML = '';

    if (qType === 'free_text_only') {
      // Scene 1 (BEFORE): カード選択＋自由記述のみ
      choiceBlock.style.display = 'none';
      rationaleCard.style.display = 'block';
      rationaleStepBadge.textContent = '統合アセスメント文章の自由記述（必須）';
    } else if (qType === 'multi_select') {
      // Scene 3 (AFTER 2): 複数選択式（6個から正しいものをすべて選択）
      choiceBlock.style.display = 'block';
      decisionStepBadge.textContent = '胸腔ドレーンのアセスメント（複数選択式：当てはまるものをすべて選択）';
      document.getElementById('decision-prompt').textContent = sceneDef.decisionPrompt;
      rationaleCard.style.display = 'none'; // 長い自由記述は不要

      (sceneDef.decisions || []).forEach(dec => {
        const isChecked = selectedMultiDecisions.includes(dec.id);
        const div = document.createElement('div');
        div.className = `decision-choice multi-choice ${isChecked ? 'active' : ''}`;
        div.innerHTML = `
          <div class="multi-choice-row">
            <span class="multi-checkbox-icon">${isChecked ? '☑️' : '⬜'}</span>
            <div>
              <div class="decision-choice-label">${escapeHtml(dec.label)}</div>
              <div class="decision-choice-desc">${escapeHtml(dec.description)}</div>
            </div>
          </div>
        `;
        div.addEventListener('click', () => {
          const idx = selectedMultiDecisions.indexOf(dec.id);
          if (idx >= 0) {
            selectedMultiDecisions.splice(idx, 1);
          } else {
            selectedMultiDecisions.push(dec.id);
          }
          selectedMultiDecisions.sort();
          draftMultiDecisions[currentSid] = [...selectedMultiDecisions];
          renderDecisionsAndRationale(sceneDef, currentSid);
        });
        container.appendChild(div);
      });
    } else {
      // Scene 2 (AFTER) & Scene 4 (NEXT): 4択判断 ＋ 自由記述
      choiceBlock.style.display = 'block';
      decisionStepBadge.textContent = currentSid === 2
        ? 'STEP 1：初期対応・安全確保の判断（A〜D）'
        : 'STEP 1：最も適切な看護判断の選択（A〜D）';
      document.getElementById('decision-prompt').textContent = sceneDef.decisionPrompt;

      rationaleCard.style.display = 'block';
      rationaleStepBadge.textContent = currentSid === 2
        ? 'STEP 2：病態生理に基づく呼吸状態の自由記述（必須）'
        : 'STEP 2：Aさんへの実際の声かけの自由記述（必須）';

      (sceneDef.decisions || []).forEach(dec => {
        const div = document.createElement('div');
        div.className = `decision-choice ${selectedDecisionId === dec.id ? 'active' : ''}`;
        div.innerHTML = `
          <div class="decision-choice-label">${escapeHtml(dec.label)}</div>
          <div class="decision-choice-desc">${escapeHtml(dec.description)}</div>
        `;
        div.addEventListener('click', () => {
          container.querySelectorAll('.decision-choice').forEach(c => c.classList.remove('active'));
          div.classList.add('active');
          selectedDecisionId = dec.id;
          updateSubmitButtonState();
        });
        container.appendChild(div);
      });
    }

    updateSubmitButtonState();
  }

  // STEP 4: 個別RESULT公開画面 (Student Branch)
  function renderResultScreen() {
    showScreen('screen-result');

    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const sceneState = payload.scenes[currentSid];
    const result = sceneState.result;
    const qType = sceneDef.questionType || 'single_select_and_free_text';

    document.getElementById('result-scene-title').textContent = `${sceneDef.title}（${sceneDef.subtitle}）— 結果公開`;

    // 1. 自分たちの判断・自由記述
    const actionBlock = document.getElementById('result-action-block');
    const rationaleBlock = document.getElementById('result-rationale-block');

    if (qType === 'free_text_only') {
      actionBlock.style.display = 'none';
      rationaleBlock.style.display = 'block';
    } else if (qType === 'multi_select') {
      actionBlock.style.display = 'block';
      const chosenIds = sceneState.selectedDecisions || [];
      document.getElementById('result-user-action').textContent = `選択した項目：${chosenIds.join(' ・ ') || 'なし'}（正答：A ・ B ・ D ・ F）`;
      if (sceneState.rationaleText) {
        rationaleBlock.style.display = 'block';
      } else {
        rationaleBlock.style.display = 'none';
      }
    } else {
      actionBlock.style.display = 'block';
      rationaleBlock.style.display = 'block';
      const dec = (sceneDef.decisions || []).find(d => d.id === sceneState.decision);
      document.getElementById('result-user-action').textContent = dec ? `${dec.label}` : (sceneState.decision || '未選択');
    }

    const rationaleTextEl = document.getElementById('result-user-rationale');
    if (rationaleTextEl) {
      rationaleTextEl.textContent = sceneState.rationaleText || '（記述なし）';
    }

    const rationaleLevelEl = document.getElementById('result-rationale-level');
    if (rationaleLevelEl) {
      const evalObj = result?.rationaleEvaluation;
      if (evalObj && evalObj.level) {
        rationaleLevelEl.textContent = evalObj.level;
        rationaleLevelEl.className = `rationale-level-badge level-${(evalObj.levelCode || 'none').toLowerCase()}`;
      }
    }

    // 確認した情報 / 確認しなかった情報
    const checkedInfoGrid = document.getElementById('result-checked-info');
    checkedInfoGrid.innerHTML = '';
    (sceneDef.infoItems || []).forEach(item => {
      const wasChecked = sceneState.selectedInfo.includes(item.id);
      checkedInfoGrid.innerHTML += `
        <div class="result-check-item ${wasChecked ? 'checked' : 'unchecked'}">
          <span class="check-mark">${wasChecked ? '✓ 選択した' : '― 未選択'}</span>
          <span class="check-label">${item.icon} ${escapeHtml(item.label)}</span>
        </div>
      `;
    });

    // 2. BEFOREとAFTERの比較パネル（Scene 1・Scene 2で表示）
    const compCard = document.getElementById('result-before-after-card');
    if (compCard && payload.beforeAfterComparison && (currentSid === 1 || currentSid === 2)) {
      compCard.style.display = 'block';
      const comp = payload.beforeAfterComparison;
      document.getElementById('comp-before-cards').textContent = `選択した術前情報：${(comp.beforeSelectedLabels || []).join('、') || 'なし'}`;
      document.getElementById('comp-before-text').textContent = comp.beforePredictionText || '（未入力）';
      document.getElementById('comp-after-vitals').textContent = `術直後の実際の状態：${comp.afterActualVitals}`;
      document.getElementById('comp-after-text').textContent = currentSid === 1
        ? '（次のSCENE 2：AFTERで、この術直後の実際の状態を観察・アセスメントします）'
        : (comp.afterAssessmentText || '（未入力）');
      document.getElementById('comp-point-text').textContent = comp.comparisonPoint;
    } else if (compCard) {
      compCard.style.display = 'none';
    }

    // 3. Scene 3 複数選択の選択肢別採点・解説一覧
    const multiCard = document.getElementById('result-multi-select-card');
    const multiList = document.getElementById('result-multi-select-list');
    if (multiCard && multiList && result && Array.isArray(result.optionEvaluations) && result.optionEvaluations.length > 0) {
      multiCard.style.display = 'block';
      multiList.innerHTML = '';
      result.optionEvaluations.forEach(opt => {
        const div = document.createElement('div');
        div.className = `multi-eval-item ${opt.isAppropriateChoice ? 'eval-good' : 'eval-needs-review'}`;
        div.innerHTML = `
          <div class="multi-eval-header">
            <span class="multi-eval-status">${escapeHtml(opt.statusLabel)}</span>
            <strong>${escapeHtml(opt.label)}</strong>
          </div>
          <div class="multi-eval-exp">${escapeHtml(opt.explanation)}</div>
        `;
        multiList.appendChild(div);
      });
    } else if (multiCard) {
      multiCard.style.display = 'none';
    }

    // 4. 判断が適切だった点 ＆ さらに考えるとよい視点
    const strengthsList = document.getElementById('result-strengths-list');
    const furtherList = document.getElementById('result-further-points-list');
    if (strengthsList) {
      const items = (result?.strengths && result.strengths.length > 0)
        ? result.strengths
        : ['患者情報を確認し、グループでアセスメント・判断を導き出しました。'];
      strengthsList.innerHTML = items.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    }
    if (furtherList) {
      const items = (result?.furtherPoints && result.furtherPoints.length > 0)
        ? result.furtherPoints
        : ['模範的な思考例と自分たちの記述を比較し、病態生理のつながりを確認してみましょう。'];
      furtherList.innerHTML = items.map(f => `<li>${escapeHtml(f)}</li>`).join('');
    }

    // 5. Patient Response & 6. 模範的な思考例
    if (result) {
      const outcomeBadge = document.getElementById('patient-outcome-badge');
      outcomeBadge.textContent = result.patientOutcome;
      outcomeBadge.className = `outcome-badge outcome-${result.patientOutcome.toLowerCase().replace(/_/g, '-')}`;

      document.getElementById('student-branch-title').textContent = result.title;
      document.getElementById('student-branch-story').innerHTML = escapeHtml(result.story).replace(/\n/g, '<br>');
      document.getElementById('reflection-question-text').textContent = result.reflectionQuestion;

      const modelCard = document.getElementById('result-model-thinking-card');
      const modelText = document.getElementById('result-model-thinking-text');
      if (modelCard && modelText && result.modelThinking) {
        modelCard.style.display = 'block';
        modelText.innerHTML = escapeHtml(result.modelThinking).replace(/\n/g, '<br>');
      }
    }
  }

  // STEP 6: 授業共通解決画面 (Canonical Story)
  function renderCanonicalScreen() {
    showScreen('screen-canonical');

    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const canonical = sceneDef.canonicalStory;

    if (canonical) {
      document.getElementById('canonical-title').textContent = canonical.title;
      document.getElementById('canonical-body').innerHTML = escapeHtml(canonical.resolution).replace(/\n/g, '<br>');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
