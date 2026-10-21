(function() {
  'use strict';

  const socket = io();
  let isAuthenticated = false;
  let summaryData = null;
  let activeSummaryScene = 1;
  let activeDebriefScene = 1;

  const sceneNames = {
    1: 'SCENE 1 — BEFORE（① 術前リスクを予測する）',
    2: 'SCENE 2 — DURING（② 術後の変化に気づき、③ 必要な情報を選んで収集する）',
    3: 'SCENE 3 — AFTER（④ 追加情報を統合してアセスメントする・最重要）',
    4: 'SCENE 4 — NEXT（⑤ 看護の優先順位を判断し、⑥ 回復促進の看護につなげる）'
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
    renderSceneControlCards();
    renderGroupsTable();
    renderSummaryCharts(activeSummaryScene);
    if (document.getElementById('admin-debrief').classList.contains('active')) {
      renderDebriefView(activeDebriefScene);
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
      if (status === 'RESOLVED') { statusBadgeLabel = 'RESOLVED (解決・公式経過)'; statusClass = 'badge-resolved'; }

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
            `Scene ${i} の開放`,
            `Scene ${i} を開放しますか？\n学生端末でこのSceneの情報収集・判断・自由記述が可能になります。`,
            () => socket.emit('admin-open-scene', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnOpen);
      } else if (status === 'ACTIVE') {
        const btnRelease = createButton('📢 RELEASE RESULTS（個別結果を一斉公開）', 'btn-success', () => {
          showModal(
            `Scene ${i} の結果公開`,
            `全グループに各々の情報収集・判断・自由記述に応じた個別Resultを公開しますか？\n公開後、Debrief Modeで全体討議を行ってください。`,
            () => socket.emit('admin-release-results', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnRelease);
      } else if (status === 'RESULTS_RELEASED') {
        const btnResolve = createButton('✅ RESOLVE SCENE（公式経過Canonical Storyへ合流）', 'btn-info', () => {
          showModal(
            `Scene ${i} の解決（Resolve）`,
            `全体討議を終了し、全グループの画面に授業上の模範アセスメント・正式経過（Canonical Story）を表示しますか？`,
            () => socket.emit('admin-resolve-scene', { sceneId: i })
          );
        });
        btnGroup.appendChild(btnResolve);
      } else if (status === 'RESOLVED') {
        if (i < 4) {
          const btnNext = createButton(`🚀 OPEN NEXT SCENE（Scene ${i + 1} を開放）`, 'btn-primary', () => {
            showModal(
              `次のScene ${i + 1} の開放`,
              `全グループを一斉に次のScene ${i + 1} へ進めますか？`,
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

  // 2. グループ一覧テーブルの描画（記述アセスメント列付き）
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

      let phaseLabel = 'アセスメント中';
      let phaseClass = 'phase-thinking';
      if (g.scenePhase === 'submitted') { phaseLabel = '送信済・結果待ち'; phaseClass = 'phase-submitted'; }
      if (g.scenePhase === 'result') { phaseLabel = 'Result確認中'; phaseClass = 'phase-result'; }
      if (g.scenePhase === 'resolved') { phaseLabel = '公式経過確認済'; phaseClass = 'phase-resolved'; }

      let outcomeBadge = '―';
      if (g.patientOutcome && g.patientOutcome !== '未確定') {
        outcomeBadge = `<span class="tag-outcome outcome-${g.patientOutcome.toLowerCase().replace(/_/g, '-')}">${g.patientOutcome}</span>`;
      }

      const rationalePreview = g.rationaleText
        ? escapeHtml(g.rationaleText.slice(0, 32)) + (g.rationaleText.length > 32 ? '…' : '')
        : '<span class="text-muted">未入力</span>';

      const levelBadge = g.rationaleText
        ? `<span class="rationale-level-badge level-${(g.rationaleLevelCode || 'none').toLowerCase()}">${escapeHtml(g.rationaleLevel)}</span>`
        : '―';

      tr.innerHTML = `
        <td><strong>${escapeHtml(g.groupName)}</strong></td>
        <td>Scene ${g.currentScene}</td>
        <td><span class="phase-tag ${phaseClass}">${phaseLabel}</span></td>
        <td>${g.budgetUsed} / ${g.budgetTotal}</td>
        <td><small>${escapeHtml((g.selectedInfo || []).join(', ') || '未選択')}</small></td>
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
            `${g.groupName} — Scene ${g.currentScene} アセスメント記述全文`,
            `<strong>【選択した判断】</strong>\n${escapeHtml(g.decisionLabel)}\n\n<strong>【記述したアセスメント（${g.rationaleText.length}文字）】</strong>\n${escapeHtml(g.rationaleText)}\n\n<strong>【ルーブリック到達水準】</strong>\n${escapeHtml(g.rationaleLevel)}`,
            null,
            true
          );
        });
      }

      tbody.appendChild(tr);
    });
  }

  // 3. 回答・評価集計（Charts + 自由記述一覧）の描画
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
      <div class="clinical-q-title">❓ Clinical Question：${debrief.clinicalQuestion || '―'}</div>
      <div class="debrief-focus-box">🎯 <strong>指導の着眼点：</strong>${debrief.debriefFocus || '―'}</div>
      ${qListHtml}
    `;
    container.appendChild(questionBanner);

    if (debrief.totalSubmissions === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'text-muted';
      emptyMsg.style.cssText = 'padding: 2rem 0; text-align:center;';
      emptyMsg.textContent = `Scene ${sceneId} の回答データはまだありません`;
      container.appendChild(emptyMsg);
      return;
    }

    const chartsDiv = document.createElement('div');
    chartsDiv.innerHTML = `
      <div class="chart-section">
        <h4>📋 情報選択率（Information Selection Distribution）</h4>
        <div class="chart-bars" id="summary-info-bars"></div>
      </div>
      <div class="chart-section">
        <h4>⚖️ 最終判断の分布（Decision Distribution）</h4>
        <div class="chart-bars" id="summary-decision-bars"></div>
      </div>
      <div class="chart-section">
        <h4>🏥 患者アウトカムの分布（Patient Outcome Distribution）</h4>
        <div class="chart-bars" id="summary-outcome-bars"></div>
      </div>
      <div class="chart-section" style="margin-top: 2rem;">
        <h4>📝 各グループのアセスメント記述一覧（🌟をクリックするとDebrief画面で強調ピックアップ表示されます）</h4>
        <div id="summary-rationales-list" class="rationales-grid"></div>
      </div>
    `;
    container.appendChild(chartsDiv);

    renderBarChart(container.querySelector('#summary-info-bars'), debrief.infoCounts, '#4A90D9');
    renderBarChart(container.querySelector('#summary-decision-bars'), debrief.decisionCounts, '#2C8C7C');

    const outcomeData = Object.keys(debrief.outcomeCounts || {}).map(k => ({
      label: k,
      count: debrief.outcomeCounts[k],
      percentage: debrief.totalSubmissions > 0 ? Math.round((debrief.outcomeCounts[k] / debrief.totalSubmissions) * 100) : 0
    }));
    renderBarChart(container.querySelector('#summary-outcome-bars'), outcomeData, '#e67e22');

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
          <span class="q-badge">Clinical Question</span> ${debrief.clinicalQuestion || ''}
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
            ${debrief.debriefQuestions.map(q => `<li>${q}</li>`).join('')}
          </ul>
        </div>
      `
      : '';
    focusCard.innerHTML = `
      <div class="focus-title">🎯 指導の着眼点</div>
      <div class="focus-body">${debrief.debriefFocus || ''}</div>
      ${debriefQuestionsHtml}
    `;
    container.appendChild(focusCard);

    if (debrief.totalSubmissions === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'debrief-empty';
      emptyDiv.innerHTML = `Scene ${sceneId} の回答送信データはまだありません。<br>学生グループが判断とアセスメント記述を送信するとここに全体集計が表示されます。`;
      container.appendChild(emptyDiv);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'debrief-grid';
    grid.innerHTML = `
      <div class="debrief-card">
        <h3>1. どの情報を確認したか？（情報選択率）</h3>
        <div class="debrief-bars" id="debrief-info-bars"></div>
      </div>

      <div class="debrief-card">
        <h3>2. どう判断したか？（看護判断の分布）</h3>
        <div class="debrief-bars" id="debrief-decision-bars"></div>
      </div>

      <div class="debrief-card full-width">
        <h3>3. 📝 学生グループのアセスメント記述ピックアップ・共有（匿名表示）</h3>
        <p class="text-muted" style="margin-top:-0.5rem; margin-bottom:1rem; font-size:0.95rem;">
          設問：${escapeHtml(debrief.rationalePrompt || '')}
        </p>
        <div id="debrief-rationales-list" class="rationales-grid debrief-rationales-grid"></div>
      </div>

      <div class="debrief-card full-width">
        <h3>4. 患者の状態変化（Patient Outcome）</h3>
        <div class="debrief-bars" id="debrief-outcome-bars"></div>
      </div>
    `;
    container.appendChild(grid);

    renderBarChart(container.querySelector('#debrief-info-bars'), debrief.infoCounts, '#4A90D9', true);
    renderBarChart(container.querySelector('#debrief-decision-bars'), debrief.decisionCounts, '#2C8C7C', true);

    const outcomeData = Object.keys(debrief.outcomeCounts || {}).map(k => ({
      label: k,
      count: debrief.outcomeCounts[k],
      percentage: debrief.totalSubmissions > 0 ? Math.round((debrief.outcomeCounts[k] / debrief.totalSubmissions) * 100) : 0
    }));
    renderBarChart(container.querySelector('#debrief-outcome-bars'), outcomeData, '#e67e22', true);

    renderRationaleCards(container.querySelector('#debrief-rationales-list'), debrief.rationaleEntries || [], sceneId, true);
  }

  function renderRationaleCards(container, entries, sceneId, isAnonymousProjector = false) {
    if (!container) return;
    container.innerHTML = '';

    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="text-muted">まだアセスメント記述の提出はありません</div>';
      return;
    }

    // ピックアップされた記述を先頭にソート
    const sorted = [...entries].sort((a, b) => (b.highlighted ? 1 : 0) - (a.highlighted ? 1 : 0));

    sorted.forEach(entry => {
      const card = document.createElement('div');
      card.className = `rationale-share-card ${entry.highlighted ? 'highlighted' : ''}`;

      const displayTitle = isAnonymousProjector ? entry.anonymousLabel : `${entry.groupName}（投影時：${entry.anonymousLabel}）`;
      const matchedTags = (entry.matchedElements || []).map(el => `<span class="matched-element-tag">✓ ${escapeHtml(el)}</span>`).join('');

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
        <div class="rationale-share-body">${escapeHtml(entry.rationaleText)}</div>
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

  function renderBarChart(container, dataList, color, isLarge = false) {
    if (!container) return;
    container.innerHTML = '';

    (dataList || []).forEach(item => {
      const row = document.createElement('div');
      row.className = `bar-row ${isLarge ? 'bar-large' : ''}`;

      row.innerHTML = `
        <div class="bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${Math.max(item.percentage, 2)}%; background-color: ${color};"></div>
        </div>
        <div class="bar-val">${item.percentage}% (${item.count}組)</div>
      `;
      container.appendChild(row);
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
