(function() {
  'use strict';

  let socket;
  let groupId = localStorage.getItem('lcs_group_id');
  let groupName = localStorage.getItem('lcs_group_name');
  let payload = null; // サーバーからの最新データ

  let selectedDecisionId = null;
  let lastRenderedSceneId = null;
  let manualDecisionOpen = false;
  const draftRationales = {}; // Sceneごとの入力中テキスト保持

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
      <circle cx="53" cy="32" r="2" fill="white"/>
      <circle cx="67" cy="32" r="2" fill="white"/>
      <path d="M 54 43 Q 60 38 66 43" stroke="white" stroke-width="1.5" fill="none"/>
      <rect x="40" y="60" width="40" height="55" rx="8" fill="#4A90D9"/>
      <line x1="40" y1="68" x2="54" y2="82" stroke="#b7791f" stroke-width="6" stroke-linecap="round"/>
      <circle cx="66" cy="80" r="7" fill="#f56565" opacity="0.65"/>
      <line x1="80" y1="68" x2="68" y2="82" stroke="#b7791f" stroke-width="6" stroke-linecap="round"/>
      <rect x="30" y="110" width="25" height="8" rx="4" fill="#b7791f"/>
      <rect x="65" y="110" width="25" height="8" rx="4" fill="#b7791f"/>
      <text x="60" y="150" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#b7791f">術後1日目・左胸痛/息苦しさ</text>
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
      <text x="60" y="150" text-anchor="middle" font-size="10.5" font-weight="bold" fill="#2b6cb0">術後ベッド上・看護判断</text>
    </svg>`
  };

  function getAvatar(state) {
    return avatars[state] || avatars['resting'];
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
      lastRenderedSceneId = null;
      manualDecisionOpen = false;
      Object.keys(draftRationales).forEach(k => delete draftRationales[k]);
      showScreen('screen-register');
    });
  }

  function updateSubmitButtonState() {
    if (!payload) return;
    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const minLen = sceneDef?.rationaleMinLength ?? 30;
    const maxLen = sceneDef?.rationaleMaxLength ?? 400;

    const rationaleEl = document.getElementById('student-rationale');
    const text = rationaleEl ? rationaleEl.value.trim() : '';
    const len = text.length;

    draftRationales[currentSid] = rationaleEl ? rationaleEl.value : '';

    const countEl = document.getElementById('rationale-char-count');
    const hintEl = document.getElementById('rationale-status-hint');
    if (countEl) {
      countEl.textContent = `${len} / ${maxLen} 文字（最小 ${minLen} 文字）`;
    }

    if (hintEl) {
      if (len < minLen) {
        hintEl.textContent = `あと ${minLen - len} 文字以上で送信可能になります`;
        hintEl.className = 'rationale-status-hint status-short';
      } else if (!selectedDecisionId) {
        hintEl.textContent = '✓ 文字数OK（上の選択肢 A〜D を選んでください）';
        hintEl.className = 'rationale-status-hint status-almost';
      } else {
        hintEl.textContent = '✓ 選択・文字数ともに送信可能です';
        hintEl.className = 'rationale-status-hint status-ready';
      }
    }

    const submitBtn = document.getElementById('btn-submit-decision');
    if (submitBtn) {
      submitBtn.disabled = !(selectedDecisionId && len >= minLen && len <= maxLen);
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
      if (!selectedDecisionId || !payload) return;
      const currentSceneId = payload.currentScene;
      const sceneDef = payload.scenario.scenes[String(currentSceneId)];
      const dec = sceneDef.decisions.find(d => d.id === selectedDecisionId);
      const rationaleText = document.getElementById('student-rationale').value.trim();

      document.getElementById('confirm-title').textContent = sceneDef.confirmPrompt || 'この判断とアセスメント記述でよいですか？';
      document.getElementById('confirm-detail').textContent = dec ? `${dec.label}` : selectedDecisionId;
      document.getElementById('confirm-rationale-preview').textContent = rationaleText;
      document.getElementById('confirm-modal').style.display = 'flex';
    });

    document.getElementById('btn-confirm-no').addEventListener('click', () => {
      document.getElementById('confirm-modal').style.display = 'none';
    });

    document.getElementById('btn-confirm-yes').addEventListener('click', () => {
      document.getElementById('confirm-modal').style.display = 'none';
      if (!selectedDecisionId || !payload) return;
      const rationaleText = document.getElementById('student-rationale').value.trim();

      socket.emit('submit-decision', {
        groupId,
        sceneId: payload.currentScene,
        decisionId: selectedDecisionId,
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
      summaryText.innerHTML = `<strong>${p.name} (${p.age}歳 ${p.gender})</strong><br>
        背景・既往歴：${p.history.join('、')}<br>
        診断・手術：${p.diagnosis} ／ ${p.treatment}<br>
        概要：${p.currentStatus}`;
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

    // Sceneが切り替わった場合の初期化
    if (lastRenderedSceneId !== currentSid) {
      lastRenderedSceneId = currentSid;
      selectedDecisionId = sceneState.decision || null;
      manualDecisionOpen = false;
      const rationaleEl = document.getElementById('student-rationale');
      if (rationaleEl) {
        rationaleEl.value = sceneState.rationaleText || draftRationales[currentSid] || '';
      }
    }

    // プログレスバー
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
          <div class="speech-speaker">${payload.scenario.patient.name}</div>
          <div class="speech-text">${d.text}</div>
        </div>
      `;
    });

    // 初期提示サマリー
    const initialSummary = document.getElementById('initial-summary-text');
    if (initialSummary) {
      if (sceneDef.initialInfo && sceneDef.initialInfo.summary) {
        initialSummary.style.display = 'block';
        initialSummary.innerHTML = sceneDef.initialInfo.summary.replace(/\n/g, '<br>');
      } else {
        initialSummary.style.display = 'none';
      }
    }

    // 初期提示バイタルサイン
    const vitalsList = document.getElementById('vitals-list');
    vitalsList.innerHTML = '';
    if (sceneDef.initialInfo && sceneDef.initialInfo.vitals) {
      sceneDef.initialInfo.vitals.forEach(v => {
        vitalsList.innerHTML += `
          <div class="vital-item">
            <span class="vital-label">${v.label}</span>
            <span class="vital-value">${v.value}</span>
          </div>
        `;
      });
    }

    // 指示文
    document.getElementById('instruction-box').innerHTML = sceneDef.instruction.replace(/\n/g, '<br>');

    // 回復を促進する看護の関連表 (Scene 4)
    const lifeActivitiesEl = document.getElementById('life-activities');
    const lifeActivitiesTitleEl = document.getElementById('life-activities-title');
    if (sceneDef.lifeActivities) {
      lifeActivitiesEl.style.display = 'block';
      if (lifeActivitiesTitleEl && sceneDef.lifeActivitiesTitle) {
        lifeActivitiesTitleEl.textContent = sceneDef.lifeActivitiesTitle;
      }
      const actList = document.getElementById('activities-list');
      actList.innerHTML = '';
      sceneDef.lifeActivities.forEach(a => {
        actList.innerHTML += `
          <div class="activity-row">
            <div class="activity-name"><strong>${a.activity}</strong></div>
            <div class="activity-mets">${a.mets}</div>
            <div class="activity-desc">${a.description}</div>
          </div>
        `;
      });
    } else {
      lifeActivitiesEl.style.display = 'none';
    }

    // Information Budget ドット表示
    renderBudget(sceneState.budget, sceneState.remainingBudget);

    // 情報選択肢カード一覧
    renderInfoItems(sceneDef.infoItems, sceneState.selectedInfo, sceneState.remainingBudget);

    // 取得済み情報一覧
    renderCollectedInfo(sceneDef.infoItems, sceneState.selectedInfo);

    // 判断＋自由記述セクション
    renderDecisionsAndRationale(sceneDef);

    // 判断へ進むボタン制御
    const proceedWrap = document.getElementById('proceed-btn-wrap');
    const decisionSection = document.getElementById('decision-section');
    if (sceneState.remainingBudget === 0 || manualDecisionOpen) {
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

  function renderBudget(totalBudget, remaining) {
    const dotsEl = document.getElementById('budget-dots');
    dotsEl.innerHTML = '';
    for (let i = 0; i < totalBudget; i++) {
      const dot = document.createElement('span');
      dot.className = `budget-dot ${i < remaining ? 'available' : 'used'}`;
      dotsEl.appendChild(dot);
    }
    const textEl = document.getElementById('budget-text');
    textEl.textContent = `残り ${remaining} つの情報を確認できます`;
    if (remaining === 0) {
      textEl.textContent = `Budgetをすべて使用しました。下の看護判断・アセスメント記述へ進んでください。`;
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

      let contentHtml = '';
      if (isSelected) {
        contentHtml = `
          <div class="info-card-header">
            <span class="info-card-icon">${item.icon}</span>
            <span class="info-card-title">✓ ${item.label}</span>
          </div>
          <div class="info-card-content">${item.content.replace(/\n/g, '<br>')}</div>
        `;
      } else {
        contentHtml = `
          <div class="info-card-header">
            <span class="info-card-icon">${item.icon}</span>
            <span class="info-card-title">${item.label}</span>
          </div>
          <div class="info-card-hint">クリックして確認する</div>
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
      card.innerHTML = contentHtml;
      container.appendChild(card);
    });
  }

  function renderCollectedInfo(infoItems, selectedIds) {
    const section = document.getElementById('collected-info-section');
    const list = document.getElementById('collected-info-list');
    list.innerHTML = '';

    if (selectedIds.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    selectedIds.forEach(id => {
      const item = infoItems.find(i => i.id === id);
      if (item) {
        list.innerHTML += `
          <div class="collected-item">
            <div class="collected-item-label">${item.icon} ${item.label}</div>
            <div class="collected-item-text">${item.content.replace(/\n/g, '<br>')}</div>
          </div>
        `;
      }
    });
  }

  function renderDecisionsAndRationale(sceneDef) {
    document.getElementById('decision-prompt').textContent = sceneDef.decisionPrompt;
    const rationalePromptEl = document.getElementById('rationale-prompt');
    if (rationalePromptEl && sceneDef.rationalePrompt) {
      rationalePromptEl.textContent = sceneDef.rationalePrompt;
    }

    const rationaleEl = document.getElementById('student-rationale');
    if (rationaleEl && sceneDef.rationaleMaxLength) {
      rationaleEl.maxLength = sceneDef.rationaleMaxLength;
    }

    const container = document.getElementById('decision-options');
    container.innerHTML = '';

    (sceneDef.decisions || []).forEach(dec => {
      const div = document.createElement('div');
      div.className = `decision-choice ${selectedDecisionId === dec.id ? 'active' : ''}`;
      div.innerHTML = `
        <div class="decision-choice-label">${dec.label}</div>
        <div class="decision-choice-desc">${dec.description}</div>
      `;
      div.addEventListener('click', () => {
        container.querySelectorAll('.decision-choice').forEach(c => c.classList.remove('active'));
        div.classList.add('active');
        selectedDecisionId = dec.id;
        updateSubmitButtonState();
      });
      container.appendChild(div);
    });

    updateSubmitButtonState();
  }

  // STEP 4: 個別RESULT公開画面 (Student Branch)
  function renderResultScreen() {
    showScreen('screen-result');

    const currentSid = payload.currentScene;
    const sceneDef = payload.scenario.scenes[String(currentSid)];
    const sceneState = payload.scenes[currentSid];
    const result = sceneState.result;

    document.getElementById('result-scene-title').textContent = `${sceneDef.title} — 結果公開`;

    // あなたたちの判断
    const dec = sceneDef.decisions.find(d => d.id === sceneState.decision);
    document.getElementById('result-user-action').textContent = dec ? `${dec.label}` : (sceneState.decision || '未選択');

    // あなたたちのアセスメント記述
    const rationaleTextEl = document.getElementById('result-user-rationale');
    if (rationaleTextEl) {
      rationaleTextEl.textContent = sceneState.rationaleText || '（記述なし）';
    }

    const rationaleLevelEl = document.getElementById('result-rationale-level');
    if (rationaleLevelEl) {
      const evalObj = result?.rationaleEvaluation;
      if (evalObj && evalObj.level) {
        rationaleLevelEl.textContent = `到達水準：${evalObj.level}`;
        rationaleLevelEl.className = `rationale-level-badge level-${(evalObj.levelCode || 'none').toLowerCase()}`;
      } else {
        rationaleLevelEl.textContent = '記述記録済み';
        rationaleLevelEl.className = 'rationale-level-badge';
      }
    }

    // 確認した情報 / 確認しなかった情報
    const checkedInfoGrid = document.getElementById('result-checked-info');
    checkedInfoGrid.innerHTML = '';
    sceneDef.infoItems.forEach(item => {
      const wasChecked = sceneState.selectedInfo.includes(item.id);
      checkedInfoGrid.innerHTML += `
        <div class="result-check-item ${wasChecked ? 'checked' : 'unchecked'}">
          <span class="check-mark">${wasChecked ? '✓ 確認した' : '― 未確認'}</span>
          <span class="check-label">${item.icon} ${item.label}</span>
        </div>
      `;
    });

    // Patient Response (Student Branch)
    if (result) {
      const outcomeBadge = document.getElementById('patient-outcome-badge');
      outcomeBadge.textContent = result.patientOutcome;
      outcomeBadge.className = `outcome-badge outcome-${result.patientOutcome.toLowerCase().replace(/_/g, '-')}`;

      document.getElementById('student-branch-title').textContent = result.title;
      document.getElementById('student-branch-story').innerHTML = result.story.replace(/\n/g, '<br>');
      document.getElementById('reflection-question-text').textContent = result.reflectionQuestion;
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
      document.getElementById('canonical-body').innerHTML = canonical.resolution.replace(/\n/g, '<br>');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
