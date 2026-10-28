(function() {
  'use strict';

  const socket = io();
  let isAuthenticated = false;
  let summaryData = null;
  let activeSummaryScene = 1;
  let activeDebriefScene = 1;

  const sceneNames = {
    1: 'SCENE 1：BEFORE（術前呼吸機能のアセスメント）',
    2: 'SCENE 2：AFTER（術直後の呼吸状態）',
    3: 'SCENE 3：AFTER 2（胸腔ドレーンのアセスメント）',
    4: 'SCENE 4：NEXT（初回離床の看護判断）'
  };

  function init() {
    setupEventListeners();
    setupSocketListeners();
  }

  function showToast(message) {
    const toast = document.getElementById('admin-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showModal(title, message, onConfirm, infoOnly = false) {
    const modal = document.getElementById('admin-confirm-modal');
    document.getElementById('admin-modal-title').textContent = title;
    document.getElementById('admin-modal-msg').innerHTML = message.replace(/\n/g, '<br>');

    const okBtn = document.getElementById('btn-admin-modal-ok');
    const cancelBtn = document.getElementById('btn-admin-modal-cancel');

    if (infoOnly) {
      okBtn.style.display = 'none';
      cancelBtn.textContent = '閉じる';
    } else {
      okBtn.style.display = 'inline-block';
      cancelBtn.textContent = 'キャンセル';
    }

    const handleOk = () => {
      cleanup();
      modal.style.display = 'none';
      if (onConfirm) onConfirm();
    };

    const handleCancel = () => {
      cleanup();
      modal.style.display = 'none';
    };

    function cleanup() {
      okBtn.removeEventListener('click', handleOk);
      cancelBtn.removeEventListener('click', handleCancel);
    }

    okBtn.addEventListener('click', handleOk);
    cancelBtn.addEventListener('click', handleCancel);

    modal.style.display = 'flex';
  }

  function setupEventListeners() {
    // ログイン
    document.getElementById('btn-admin-login').addEventListener('click', handleLogin);
    document.getElementById('admin-password').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleLogin();
    });

    // タブ切り替え
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        const targetId = `tab-${tab.dataset.tab}`;
        const content = document.getElementById(targetId);
        if (content) content.classList.add('active');
      });
    });

    // Debriefing モード
    document.getElementById('btn-debrief-mode').addEventListener('click', () => {
      document.getElementById('admin-dashboard').classList.remove('active');
      document.getElementById('admin-debrief').classList.add('active');
      renderDebriefView(activeDebriefScene);
    });

    document.getElementById('btn-exit-debrief').addEventListener('click', () => {
      document.getElementById('admin-debrief').classList.remove('active');
      document.getElementById('admin-dashboard').classList.add('active');
    });

    document.querySelectorAll('.debrief-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.debrief-nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeDebriefScene = parseInt(btn.dataset.debriefScene);
        renderDebriefView(activeDebriefScene);
      });
    });

    // 集計タブのScene切り替え
    document.querySelectorAll('.scene-selector-bar .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.scene-selector-bar .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSummaryScene = parseInt(btn.dataset.summaryScene);
        renderSummaryCharts(activeSummaryScene);
      });
    });

    // URL コピー
    document.getElementById('btn-copy-url').addEventListener('click', () => {
      const urlInput = document.getElementById('student-access-url');
      urlInput.select();
      navigator.clipboard.writeText(urlInput.value).then(() => {
        showToast('URLをクリップボードにコピーしました！');
      }).catch(() => {
        showToast('コピーに失敗しました。手動でコピーしてください。');
      });
    });

    // 更新 & リセット
    document.getElementById('btn-refresh').addEventListener('click', () => {
      socket.emit('admin-get-summary');
      showToast('最新データを取得しました');
    });

    document.getElementById('btn-admin-reset').addEventListener('click', () => {
      showModal(
        '全グループデータの初期化',
        '本当にすべての参加グループおよび回答・記述ログを削除してリセットしますか？\nこの操作は取り消せません。',
        () => {
          socket.emit('admin-reset-all');
        }
      );
    });

    // 個人復習（自習）モード切替ボタン（ヘッダー＆制御タブ両方）
    const handleToggleSelfStudy = () => {
      const currentMode = !!(summaryData && summaryData.selfStudyMode);
      const nextMode = !currentMode;
      if (nextMode) {
        showModal(
          '📚 個人復習（自習）モードへの切り替え',
          '「個人復習（自習）モード」をONにしますか？\n\n・学生は回答送信後、待機画面で止まらずに即座にResultと模範例を確認できるようになります。\n・学生自身が「次のSceneへ進む」「最初からもう一度挑戦する（リセット）」ボタンを使って、1人で何度でも最初から最後まで復習できるようになります。',
          () => {
            socket.emit('admin-toggle-self-study-mode', { enabled: true });
            showToast('📚 個人復習（自習）モードをONにしました');
          }
        );
      } else {
        showModal(
          '👨‍🏫 授業連動モードへの切り替え',
          '「授業連動モード（教員の操作で一斉進行）」に戻しますか？',
          () => {
            socket.emit('admin-toggle-self-study-mode', { enabled: false });
            showToast('👨‍🏫 授業連動モードに戻しました');
          }
        );
      }
    };
    ['btn-toggle-self-study', 'btn-toggle-self-study-header'].forEach(btnId => {
      const el = document.getElementById(btnId);
      if (el) el.addEventListener('click', handleToggleSelfStudy);
    });
  }

  function handleLogin() {
    const password = document.getElementById('admin-password').value;
    socket.emit('admin-login', { password });
  }

  function setupSocketListeners() {
    socket.on('admin-auth-result', (data) => {
      if (data.success) {
        isAuthenticated = true;
        document.getElementById('admin-login-screen').classList.remove('active');
        document.getElementById('admin-dashboard').classList.add('active');
        document.getElementById('admin-login-error').style.display = 'none';
        socket.emit('admin-get-summary');
      } else {
        document.getElementById('admin-login-error').style.display = 'block';
      }
    });

    socket.on('admin-summary-updated', (data) => {
      summaryData = data;
      renderAll();
    });

    socket.on('admin-reset-done', () => {
      showToast('全データをリセットしました');
      socket.emit('admin-get-summary');
    });
  }

  function renderAll() {
    if (!summaryData) return;
    renderNetworkInfo();
    renderSelfStudyModeCard();
    renderSceneControlCards();
    renderGroupsTable();
    renderSummaryCharts(activeSummaryScene);
    if (document.getElementById('admin-debrief').classList.contains('active')) {
      renderDebriefView(activeDebriefScene);
    }
  }

  function renderSelfStudyModeCard() {
    const isSelfStudy = !!(summaryData && summaryData.selfStudyMode);
    const card = document.getElementById('self-study-mode-card');
    const badge = document.getElementById('self-study-status-badge');
    const desc = document.getElementById('self-study-status-desc');
    const btn = document.getElementById('btn-toggle-self-study');
    const headerBtn = document.getElementById('btn-toggle-self-study-header');

    if (headerBtn) {
      if (isSelfStudy) {
        headerBtn.className = 'btn btn-success';
        headerBtn.textContent = '📚 個人復習モード：ON（クリックで授業モードへ戻す）';
      } else {
        headerBtn.className = 'btn btn-primary';
        headerBtn.textContent = '📚 個人復習モード：OFF（クリックでONにする）';
      }
    }

    if (!card || !badge || !desc || !btn) return;

    if (isSelfStudy) {
      card.style.borderLeftColor = '#38a169';
      card.style.background = '#f0fff4';
      badge.style.background = '#38a169';
      badge.textContent = '📚 現在：個人復習（自習）モード ON（学生が各自のペースで何度でも進行・再挑戦可能）';
      desc.textContent = '現在、学生は教員の操作を待たずに回答送信後すぐ結果と模範例を確認し、1人でSCENE 1〜4を最後まで進めたり、自分の端末で何度でも最初からリセットしてやり直すことができます。';
      btn.className = 'btn btn-secondary';
      btn.textContent = '👨‍🏫 授業連動モードに戻す';
    } else {
      card.style.borderLeftColor = '#2b6cb0';
      card.style.background = '#ffffff';
      badge.style.background = '#2b6cb0';
      badge.textContent = '👨‍🏫 現在：授業連動モード（教員の操作で一斉進行）';
      desc.textContent = '授業終了後に「📚 個人復習（自習）モード」をONにすると、学生は教員の操作を待たずに1人でSCENE 1〜4を最後まで進めることができ、自分の端末で何度でも最初からやり直して復習できるようになります。';
      btn.className = 'btn btn-primary';
      btn.textContent = '📚 個人復習（自習）モードをONにする';
    }
  }

  // 0. ネットワーク接続案内カードの描画
  function renderNetworkInfo() {
    if (!summaryData || !summaryData.networkInfo) return;
    const net = summaryData.networkInfo;

    const urlInput = document.getElementById('student-access-url');
    if (urlInput && net.studentUrl) {
      urlInput.value = net.studentUrl;
    }

    const qrImg = document.getElementById('qr-code-img');
    const qrLoading = document.getElementById('qr-loading-text');
    if (qrImg && net.qrCodeDataUrl) {
      qrImg.src = net.qrCodeDataUrl;
      qrImg.style.display = 'block';
      if (qrLoading) qrLoading.style.display = 'none';
    }
  }

  // 1. Scene進行制御カードの描画
  function renderSceneControlCards() {
    const container = document.getElementById('scene-control-cards');
    container.innerHTML = '';

    const statuses = summaryData.sceneStatuses || {};

    for (let i = 1; i <= 4; i++) {
      const status = statuses[i] || 'LOCKED';
      const card = document.createElement('div');
      card.className = `scene-ctrl-card status-${status.toLowerCase()}`;

      let statusBadgeLabel = status;
      let statusClass = 'badge-locked';
      if (status === 'ACTIVE') { statusBadgeLabel = 'ACTIVE (開放中)'; statusClass = 'badge-active'; }
      if (status === 'RESULTS_RELEASED') { statusBadgeLabel = 'RESULTS RELEASED (結果公開中)'; statusClass = 'badge-released'; }
      if (status === 'RESOLVED') { statusBadgeLabel = 'RESOLVED (解決・模範例公開)'; statusClass = 'badge-resolved'; }

      let submittedCount = 0;
      (summaryData.groups || []).forEach(g => {
        if (g.currentScene === i && g.scenePhase === 'submitted') submittedCount++;
      });
      const total = summaryData.totalGroups || 0;

      card.innerHTML = `
        <div class="ctrl-card-header">
          <div class="ctrl-scene-name">${sceneNames[i]}</div>
          <span class="status-pill ${statusClass}">${statusBadgeLabel}</span>
        </div>
        <div class="ctrl-card-body">
          <div class="ctrl-stat-row">
            <span>現在の回答送信状況：</span>
            <strong>${submittedCount} / ${total} グループ送信済み</strong>
          </div>
          <div class="ctrl-btn-group" id="btn-group-scene-${i}"></div>
        </div>
      `;

      const btnGroup = card.querySelector(`#btn-group-scene-${i}`);

      if (status === 'LOCKED') {
        const btnOpen = createButton('▶ OPEN SCENE（Sceneを開放）', 'btn-primary', () => {
          showModal(
            `${sceneNames[i]} の開放`,
            `${sceneNames[i]} を開放しますか？\n学生端末でこのSceneの操作・回答が可能になります。`,
            () => socket.emit('admin-open-scene', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnOpen);
      } else if (status === 'ACTIVE') {
        const btnRelease = createButton('📢 RELEASE RESULTS（結果・フィードバックを一斉公開）', 'btn-success', () => {
          showModal(
            `${sceneNames[i]} の結果公開`,
            `全グループに個別Result（模範的な思考例・良かった点・さらに考えるとよい視点）を公開しますか？\n公開後、Debrief Modeで全体共有・討議を行ってください。`,
            () => socket.emit('admin-release-results', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnRelease);
      } else if (status === 'RESULTS_RELEASED') {
        const btnResolve = createButton('✅ RESOLVE SCENE（統合模範例・Canonical Storyへ合流）', 'btn-info', () => {
          showModal(
            `${sceneNames[i]} の解決（Resolve）`,
            `全体討議を終了し、全グループの画面に統合アセスメント模範例（Canonical Story）を表示しますか？`,
            () => socket.emit('admin-resolve-scene', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnResolve);
        const btnReopen = createButton('🔄 このSceneを再開放', 'btn-secondary btn-sm', () => {
          socket.emit('admin-open-scene', { sceneId: i });
        });
        btnGroup.appendChild(btnReopen);
      } else if (status === 'RESOLVED') {
        if (i < 4) {
          const btnNext = createButton(`🚀 OPEN NEXT SCENE（${sceneNames[i + 1]} を開放）`, 'btn-primary', () => {
            showModal(
              `次のScene ${i + 1} の開放`,
              `全グループを一斉に次の ${sceneNames[i + 1]} へ進めますか？`,
              () => socket.emit('admin-open-next-scene', { currentSceneId: i })
            );
          });
          btnGroup.appendChild(btnNext);
        } else {
          const spanDone = document.createElement('span');
          spanDone.className = 'text-success font-bold';
          spanDone.textContent = '🎉 全シミュレーション完了';
          btnGroup.appendChild(spanDone);
        }
        const btnReopen = createButton('🔄 このSceneを再開放', 'btn-secondary btn-sm', () => {
          socket.emit('admin-open-scene', { sceneId: i });
        });
        btnGroup.appendChild(btnReopen);
      }

      container.appendChild(card);
    }
  }

  function createButton(text, className, onClick) {
    const btn = document.createElement('button');
    btn.className = `btn ${className}`;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // 2. グループ一覧テーブルの描画
  function renderGroupsTable() {
    const tbody = document.getElementById('groups-table-body');
    const countEl = document.getElementById('group-count');
    const groups = summaryData.groups || [];

    countEl.textContent = groups.length;
    tbody.innerHTML = '';

    if (groups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-muted" style="text-align:center;">参加グループはありません</td></tr>';
      return;
    }

    groups.forEach(g => {
      const tr = document.createElement('tr');

      let phaseLabel = '検討・入力中';
      let phaseClass = 'phase-thinking';
      if (g.scenePhase === 'submitted') { phaseLabel = '送信済・WAIT中'; phaseClass = 'phase-submitted'; }
      if (g.scenePhase === 'result') { phaseLabel = 'Result確認中'; phaseClass = 'phase-result'; }
      if (g.scenePhase === 'resolved') { phaseLabel = '模範例確認済'; phaseClass = 'phase-resolved'; }

      let outcomeBadge = '―';
      if (g.patientOutcome && g.patientOutcome !== '未確定') {
        outcomeBadge = `<span class="tag-outcome outcome-${g.patientOutcome.toLowerCase().replace(/_/g, '-')}">${g.patientOutcome}</span>`;
      }

      const rationalePreview = g.rationaleText
        ? escapeHtml(g.rationaleText.slice(0, 34)) + (g.rationaleText.length > 34 ? '…' : '')
        : '<span class="text-muted">―</span>';

      const levelBadge = g.rationaleLevel && g.rationaleLevel !== '未評価'
        ? `<span class="rationale-level-badge level-${(g.rationaleLevelCode || 'none').toLowerCase()}">${escapeHtml(g.rationaleLevel)}</span>`
        : '―';

      const selectedLabelsStr = (g.selectedInfoLabels && g.selectedInfoLabels.length > 0)
        ? g.selectedInfoLabels.join('、')
        : '未選択';

      tr.innerHTML = `
        <td><strong>${escapeHtml(g.groupName)}</strong></td>
        <td>Scene ${g.currentScene}</td>
        <td><span class="phase-tag ${phaseClass}">${phaseLabel}</span></td>
        <td>${g.budgetUsed} / ${g.budgetTotal}</td>
        <td><small>${escapeHtml(selectedLabelsStr)}</small></td>
        <td><small>${escapeHtml(g.decisionLabel || '未決定')}</small></td>
        <td class="rationale-cell">
          <div class="rationale-cell-preview">${rationalePreview}</div>
          ${g.rationaleText ? `<button class="btn btn-secondary btn-sm btn-view-rationale" style="margin-top:4px; font-size:0.75rem; padding:2px 8px;">📖 全文表示</button>` : ''}
        </td>
        <td>${levelBadge}</td>
        <td>${outcomeBadge}</td>
      `;

      const viewBtn = tr.querySelector('.btn-view-rationale');
      if (viewBtn) {
        viewBtn.addEventListener('click', () => {
          showModal(
            `${g.groupName} — Scene ${g.currentScene} 回答・記述全文`,
            `<strong>【選択した情報カード】</strong>\n${escapeHtml(selectedLabelsStr)}\n\n<strong>【選択した判断】</strong>\n${escapeHtml(g.decisionLabel)}\n\n<strong>【自由記述全文（${g.rationaleText.length}文字）】</strong>\n${escapeHtml(g.rationaleText)}\n\n<strong>【形成的ルーブリック参考表示】</strong>\n${escapeHtml(g.rationaleLevel)}`,
            null,
            true
          );
        });
      }

      tbody.appendChild(tr);
    });
  }

  // 3. Scene別回答比較・集計タブの描画
  function renderSummaryCharts(sceneId) {
    const container = document.getElementById('summary-charts-content');
    container.innerHTML = '';

    const debrief = summaryData.debrief ? summaryData.debrief[sceneId] : null;
    if (!debrief) return;

    const questionBanner = document.createElement('div');
    questionBanner.className = 'debrief-question-banner';
    const qListHtml = (debrief.debriefQuestions && debrief.debriefQuestions.length > 0)
      ? `<div style="margin-top:0.4rem; font-size:0.85rem; color:#4a5568;"><strong>💬 発問例：</strong>${debrief.debriefQuestions.join(' / ')}</div>`
      : '';
    questionBanner.innerHTML = `
      <div class="clinical-q-title">❓ Clinical Question：${escapeHtml(debrief.clinicalQuestion || '―')}</div>
      <div class="debrief-focus-box">🎯 <strong>指導の着眼点：</strong>${escapeHtml(debrief.debriefFocus || '―')}</div>
      ${qListHtml}
    `;
    container.appendChild(questionBanner);

    if (debrief.totalSubmissions === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'text-muted';
      emptyMsg.style.cssText = 'padding: 2rem 0; text-align:center;';
      emptyMsg.textContent = `${sceneNames[sceneId]} の回答データはまだありません`;
      container.appendChild(emptyMsg);
      return;
    }

    const chartsDiv = document.createElement('div');
    const isMultiSelect = debrief.questionType === 'multi_select';
    const isFreeTextOnly = debrief.questionType === 'free_text_only';

    let decisionSectionHtml = '';
    if (isMultiSelect) {
      decisionSectionHtml = `
        <div class="chart-section">
          <h4>☑️ 胸腔ドレーン複数選択問題（A〜F）の選択率分布（完全正答 A・B・D・F 一致：${debrief.exactMultiSelectMatches} / ${debrief.totalSubmissions} グループ）</h4>
          <div class="chart-bars" id="summary-decision-bars"></div>
        </div>
      `;
    } else if (!isFreeTextOnly) {
      decisionSectionHtml = `
        <div class="chart-section">
          <h4>⚖️ 看護判断（A〜D）の分布</h4>
          <div class="chart-bars" id="summary-decision-bars"></div>
        </div>
      `;
    }

    let entriesHeading = '📝 グループ別 回答・自由記述の比較（🌟でDebrief画面の上部にピックアップ表示）';
    if (sceneId === 1) entriesHeading = '📝 SCENE 1 (BEFORE)：各グループが選択した患者情報と術前予測アセスメントの比較';
    if (sceneId === 2) entriesHeading = '📝 SCENE 2 (AFTER)：各グループの術直後呼吸状態アセスメント文章の比較（術前予測との対比付き）';
    if (sceneId === 3) entriesHeading = '📝 SCENE 3 (AFTER 2)：各グループの複数選択（A〜F）回答一覧';
    if (sceneId === 4) entriesHeading = '📝 SCENE 4 (NEXT)：各グループの看護判断と患者（Aさん）への声かけの比較';

    chartsDiv.innerHTML = `
      <div class="chart-section">
        <h4>📋 患者情報・観察カードの選択率（Information Selection Distribution）</h4>
        <div class="chart-bars" id="summary-info-bars"></div>
      </div>
      ${decisionSectionHtml}
      <div class="chart-section" style="margin-top: 2rem;">
        <h4>${entriesHeading}</h4>
        <div id="summary-rationales-list" class="rationales-grid"></div>
      </div>
    `;
    container.appendChild(chartsDiv);

    renderBarChart(container.querySelector('#summary-info-bars'), debrief.infoCounts, '#4A90D9', false, false);
    if (!isFreeTextOnly) {
      renderBarChart(
        container.querySelector('#summary-decision-bars'),
        debrief.decisionCounts,
        '#2C8C7C',
        false,
        isMultiSelect
      );
    }

    renderRationaleCards(container.querySelector('#summary-rationales-list'), debrief.rationaleEntries || [], sceneId, false);
  }

  // 4. Debriefing Mode（プロジェクター投影画面）の描画
  function renderDebriefView(sceneId) {
    const container = document.getElementById('debrief-main-view');
    container.innerHTML = '';

    const debrief = summaryData.debrief ? summaryData.debrief[sceneId] : null;

    if (!debrief) {
      container.innerHTML = `<div class="debrief-empty">データがロードされていません</div>`;
      return;
    }

    const headerRow = document.createElement('div');
    headerRow.className = 'debrief-header-row';
    headerRow.innerHTML = `
      <div>
        <h2>${sceneNames[sceneId]}</h2>
        <div class="debrief-clinical-question">
          <span class="q-badge">Clinical Question</span> ${escapeHtml(debrief.clinicalQuestion || '')}
        </div>
      </div>
      <div class="debrief-total-badge">回答グループ数：${debrief.totalSubmissions || 0} 組</div>
    `;
    container.appendChild(headerRow);

    const focusCard = document.createElement('div');
    focusCard.className = 'debrief-focus-card-large';
    const debriefQuestionsHtml = (debrief.debriefQuestions && debrief.debriefQuestions.length > 0)
      ? `
        <div style="margin-top: 1rem; border-top: 1px dashed #fde047; padding-top: 0.75rem;">
          <div style="font-size: 1rem; font-weight: bold; color: #b45309; margin-bottom: 0.35rem;">💬 全体討議での発問例：</div>
          <ul style="margin: 0; padding-left: 1.25rem; color: #78350f; font-size: 1.05rem; line-height: 1.6;">
            ${debrief.debriefQuestions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </div>
      `
      : '';
    focusCard.innerHTML = `
      <div class="focus-title">🎯 指導の着眼点</div>
      <div class="focus-body">${escapeHtml(debrief.debriefFocus || '')}</div>
      ${debriefQuestionsHtml}
    `;
    container.appendChild(focusCard);

    if (debrief.totalSubmissions === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'debrief-empty';
      emptyDiv.innerHTML = `${sceneNames[sceneId]} の回答送信データはまだありません。<br>学生グループが回答を送信するとここに全体集計・比較が表示されます。`;
      container.appendChild(emptyDiv);
      return;
    }

    const isMultiSelect = debrief.questionType === 'multi_select';
    const isFreeTextOnly = debrief.questionType === 'free_text_only';

    const grid = document.createElement('div');
    grid.className = 'debrief-grid';

    let rightChartCardHtml = '';
    if (isMultiSelect) {
      rightChartCardHtml = `
        <div class="debrief-card full-width">
          <h3>2. 胸腔ドレーン複数選択問題（A〜F）の選択分布（完全正答 A・B・D・F 一致：${debrief.exactMultiSelectMatches} / ${debrief.totalSubmissions} 組）</h3>
          <div class="debrief-bars" id="debrief-decision-bars"></div>
        </div>
      `;
    } else if (!isFreeTextOnly) {
      rightChartCardHtml = `
        <div class="debrief-card">
          <h3>2. どう判断したか？（看護判断の分布）</h3>
          <div class="debrief-bars" id="debrief-decision-bars"></div>
        </div>
      `;
    }

    let shareTitle = '📝 各グループの回答・アセスメント記述の比較（匿名表示）';
    if (sceneId === 1) shareTitle = '2. 📝 各グループが選択した患者情報と術前予測アセスメントの比較';
    if (sceneId === 2) shareTitle = '3. 📝 各グループの術直後呼吸状態アセスメント文章の比較';
    if (sceneId === 3) shareTitle = '3. 📝 各グループの複数選択結果一覧';
    if (sceneId === 4) shareTitle = '3. 📝 各グループの看護判断とAさんへの声かけの比較';

    grid.innerHTML = `
      <div class="debrief-card ${isFreeTextOnly || isMultiSelect ? 'full-width' : ''}">
        <h3>1. どの患者情報・観察項目を選択したか？（選択率）</h3>
        <div class="debrief-bars" id="debrief-info-bars"></div>
      </div>

      ${rightChartCardHtml}

      <div class="debrief-card full-width">
        <h3>${shareTitle}</h3>
        <p class="text-muted" style="margin-top:-0.5rem; margin-bottom:1rem; font-size:0.95rem;">
          課題：${escapeHtml(debrief.rationalePrompt || debrief.clinicalQuestion || '')}
        </p>
        <div id="debrief-rationales-list" class="rationales-grid debrief-rationales-grid"></div>
      </div>
    `;
    container.appendChild(grid);

    renderBarChart(container.querySelector('#debrief-info-bars'), debrief.infoCounts, '#4A90D9', true, false);
    if (!isFreeTextOnly) {
      renderBarChart(container.querySelector('#debrief-decision-bars'), debrief.decisionCounts, '#2C8C7C', true, isMultiSelect);
    }

    renderRationaleCards(container.querySelector('#debrief-rationales-list'), debrief.rationaleEntries || [], sceneId, true);
  }

  function renderRationaleCards(container, entries, sceneId, isAnonymousProjector = false) {
    if (!container) return;
    container.innerHTML = '';

    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="text-muted">まだ回答の提出はありません</div>';
      return;
    }

    // ピックアップされた記述を先頭にソート
    const sorted = [...entries].sort((a, b) => (b.highlighted ? 1 : 0) - (a.highlighted ? 1 : 0));

    sorted.forEach(entry => {
      const card = document.createElement('div');
      card.className = `rationale-share-card ${entry.highlighted ? 'highlighted' : ''}`;

      const displayTitle = isAnonymousProjector ? entry.anonymousLabel : `${entry.groupName}（投影時：${entry.anonymousLabel}）`;
      const selectedCardsHtml = (entry.selectedInfoLabels && entry.selectedInfoLabels.length > 0)
        ? `<div class="share-selected-info-box"><strong>選択した情報：</strong>${escapeHtml(entry.selectedInfoLabels.join('、'))}</div>`
        : '';

      const beforeCompHtml = (sceneId === 2 && entry.beforePredictionText)
        ? `<div class="share-before-ref-box"><small><strong>【参考：SCENE 1での術前予測】</strong> ${escapeHtml(entry.beforePredictionText)}</small></div>`
        : '';

      const matchedTags = (entry.matchedElements || []).map(el => `<span class="matched-element-tag">✓ ${escapeHtml(el)}</span>`).join('');

      const bodyText = entry.rationaleText
        ? `<div class="rationale-share-body">${escapeHtml(entry.rationaleText)}</div>`
        : (sceneId === 3
          ? `<div class="rationale-share-body"><strong>選択した項目：${escapeHtml((entry.selectedDecisions || []).join(' ・ ') || 'なし')}</strong>（正答：A・B・D・F）</div>`
          : '<div class="rationale-share-body text-muted">（自由記述なし）</div>');

      card.innerHTML = `
        <div class="rationale-share-header">
          <div class="rationale-share-group">
            ${entry.highlighted ? '<span class="pickup-star-badge">🌟 ピックアップ共有中</span>' : ''}
            <strong>${escapeHtml(displayTitle)}</strong>
            <span class="rationale-share-decision">${escapeHtml(entry.decisionShort)}</span>
          </div>
          <div class="rationale-share-actions">
            <span class="rationale-level-badge level-${(entry.rationaleLevelCode || 'none').toLowerCase()}">
              ${escapeHtml(entry.rationaleLevel)}
            </span>
            <button class="btn btn-sm ${entry.highlighted ? 'btn-warning' : 'btn-secondary'} btn-toggle-pickup">
              ${entry.highlighted ? '🌟 ピックアップ解除' : '☆ ピックアップ'}
            </button>
          </div>
        </div>
        ${selectedCardsHtml}
        ${bodyText}
        ${beforeCompHtml}
        ${matchedTags ? `<div class="rationale-share-tags">${matchedTags}</div>` : ''}
      `;

      const toggleBtn = card.querySelector('.btn-toggle-pickup');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          socket.emit('admin-toggle-highlight-rationale', {
            groupId: entry.groupId,
            sceneId
          });
        });
      }

      container.appendChild(card);
    });
  }

  function renderBarChart(container, dataList, color, isLarge = false, showCorrectBadge = false) {
    if (!container) return;
    container.innerHTML = '';

    (dataList || []).forEach(item => {
      const row = document.createElement('div');
      row.className = `bar-row ${isLarge ? 'bar-large' : ''}`;

      let prefixBadge = '';
      let barColor = color;
      if (showCorrectBadge) {
        if (item.isCorrect) {
          prefixBadge = '<span class="opt-correct-tag">正答</span> ';
          barColor = '#16a34a';
        } else {
          prefixBadge = '<span class="opt-wrong-tag">誤答</span> ';
          barColor = '#dc2626';
        }
      }

      row.innerHTML = `
        <div class="bar-label" title="${escapeHtml(item.label)}">${prefixBadge}${escapeHtml(item.label)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${Math.max(item.percentage, 2)}%; background-color: ${barColor};"></div>
        </div>
        <div class="bar-val">${item.percentage}% (${item.count}組)</div>
      `;
      container.appendChild(row);
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
