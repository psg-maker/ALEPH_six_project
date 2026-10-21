/* 화면은 기존 API만 호출한다. 사용자 입력은 innerHTML 대신 textContent로 표시한다. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { view: 'today', planId: null, plans: [], tasks: [], summaries: new Map(), details: new Map(), generation: 0, planFromTask: false, pendingTaskPlanId: null, pendingTaskIds: new Set(), editTaskId: null };
  const today = document.body.dataset.today;
  let executionTaskId = null;
  let executionPending = false;
  let executionHistoryRequest = 0;
  let linkTaskId = null;
  let editingPlan = null;
  let historyPlanId = null;
  let historyRequest = 0;
  const labelDate = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  $('date-label').textContent = labelDate.format(new Date(today + 'T12:00:00'));

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.detail;
      const message = Array.isArray(detail) ? detail.map(item => `${item.loc.slice(1).join('.')}: ${item.msg}`).join(' / ') : typeof detail === 'string' ? detail : '요청을 처리하지 못했습니다.';
      throw new Error(message);
    }
    // 기존 API 중 일부는 오류도 200으로 반환하므로 화면에서 한 번 더 확인한다.
    if (data && !Array.isArray(data) && data.message?.endsWith('not found')) throw new Error(data.message);
    return data;
  }
  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
  function tell(message) { $('notice').textContent = message; $('notice').hidden = false; }
  function failure(message) { $('load-error-text').textContent = message; $('load-error').hidden = false; }
  function activePlans() { return state.plans.filter(plan => plan.status === 'ACTIVE'); }
  function titleForPlan(id) { return state.plans.find(plan => plan.id === id)?.title || `계획 ${id}`; }

  function renderChrome() {
    const title = state.planId != null ? titleForPlan(state.planId) : { today: '오늘, 한 걸음 더.', all: '나의 모든 할 일', plans: '작은 목표, 꾸준한 실행.', insights: '기록에서 발견하는 다음 한 걸음.', notes: '하루의 생각을 남기는 곳.' }[state.view];
    $('page-title').textContent = title;
    $('breadcrumb').textContent = state.planId != null ? '계획별 할 일' : { today: '오늘', all: '전체 할 일', plans: '나의 계획', insights: '돌아보기', notes: '일일 메모' }[state.view];
    $('list-title').textContent = state.planId != null ? '계획의 할 일' : state.view === 'today' ? '오늘의 체크리스트' : '전체 체크리스트';
    const selectedPlan = state.plans.find(plan => plan.id === state.planId);
    $('page-caption').textContent = selectedPlan?.description || (state.view === 'plans' ? '내가 정한 목표와 진행 상황을 한눈에.' : state.view === 'insights' ? '숫자의 근거를 확인하고, 다음 계획의 방향을 찾아보세요.' : state.view === 'notes' ? '성과가 아니어도 좋아요. 오늘의 흔적을 기록하세요.' : '계획을 실행으로 바꾸는 작은 체크.');
    document.body.classList.toggle('plans-view', state.view === 'plans');
    document.body.classList.toggle('insights-view', state.view === 'insights');
    $('insights-view').hidden = state.view !== 'insights';
    document.body.classList.toggle('notes-view', state.view === 'notes');
    $('daily-notes-view').hidden = state.view !== 'notes';
    $('add-task').hidden = ['insights', 'notes'].includes(state.view);
    document.querySelectorAll('[data-view]').forEach(button => {
      const selected = button.dataset.view === state.view && state.planId == null;
      button.classList.toggle('selected', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  function renderPlans() {
    $('sidebar-plans').replaceChildren();
    activePlans().forEach(plan => {
      const button = el('button', 'sidebar-plan'); button.type = 'button';
      button.append(el('span', 'plan-dot'), el('span', '', plan.title));
      button.addEventListener('click', () => changeView('all', plan.id));
      $('sidebar-plans').append(button);
    });
    const list = $('plan-list'); list.replaceChildren();
    const plans = state.view === 'plans' ? state.plans : activePlans();
    $('plans-title').textContent = state.view === 'plans' ? '나의 계획' : '진행 중인 계획';
    if (!plans.length) {
      const empty = el('div', 'empty', state.plans.length ? '진행 중인 계획이 없습니다.' : '첫 계획을 만들어 시작해보세요.');
      const add = el('button', '', '＋ 계획 만들기'); add.type = 'button'; add.addEventListener('click', openPlan); empty.append(add); list.append(empty);
    }
    plans.forEach(plan => {
      const summary = state.summaries.get(plan.id);
      const card = el('article', 'plan-card'); const top = el('div', 'plan-top');
      const name = el('button', 'plan-name', plan.title); name.type = 'button'; name.addEventListener('click', () => changeView('all', plan.id));
      top.append(name, el('span', 'category-pill', plan.category)); card.append(top);
      const meta = el('div', 'plan-progress-label'); meta.append(el('span', '', summary ? `완료 ${summary.completed_task_count} / 전체 ${summary.task_count}` : '집계를 불러오지 못했습니다.'), el('span', '', summary ? `${summary.completion_rate}%` : '—'));
      const track = el('div', 'progress-track'); const fill = el('span'); fill.style.width = `${summary?.completion_rate || 0}%`; track.append(fill); card.append(meta, track);
      const actions = el('div', 'plan-actions');
      const edit = el('button', 'text-button plan-edit', '계획 수정'); edit.type = 'button'; edit.addEventListener('click', () => openPlan(false, plan));
      const history = el('button', 'text-button plan-history', '수정 이력'); history.type = 'button'; history.addEventListener('click', () => { historyPlanId = plan.id; $('plan-history-title').textContent = `${plan.title} · 수정 이력`; $('plan-history-dialog').showModal(); loadPlanHistory(); });
      actions.append(edit, history); card.append(actions); list.append(card);
    });
    const select = $('task-plan'); const previous = select.value; select.replaceChildren();
    state.plans.forEach(plan => { const option = el('option', '', plan.title); option.value = plan.id; select.append(option); });
    // 할 일 작성 중 만든 계획을 우선 선택하고, 폼을 새로 그려도 초안은 유지한다.
    const preferred = state.pendingTaskPlanId ?? ($('task-dialog').open && previous ? previous : state.planId ?? previous);
    if (preferred != null && state.plans.some(p => String(p.id) === String(preferred))) {
      select.value = preferred;
      state.pendingTaskPlanId = null;
    }
    if (!state.plans.length) {
      const option = el('option', '', '먼저 새 계획을 만들어주세요'); option.value = ''; select.append(option);
    }
  }

  function renderTasks() {
    const keyword = $('search').value.trim().toLocaleLowerCase(); const status = $('status-filter').value;
    const visible = state.tasks.filter(task => (!status || task.status === status) && (!keyword || `${task.title} ${task.description || ''}`.toLocaleLowerCase().includes(keyword)));
    const field = $('sort-by').value; const descending = $('sort-order').value === 'desc';
    // DB의 조회 순서와 무관하게 현재 목록을 정렬한다. 원본 배열은 변경하지 않는다.
    visible.sort((a, b) => {
      const left = a[field], right = b[field];
      const leftEmpty = left == null || left === '', rightEmpty = right == null || right === '';
      if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
      let result = 0;
      if (!leftEmpty) result = field === 'expected_minutes' ? Number(left) - Number(right) : left < right ? -1 : left > right ? 1 : 0;
      // 오름/내림 어느 쪽에서도 동률은 ID 오름차순, 미입력은 마지막이다.
      return (descending ? -result : result) || a.id - b.id;
    });
    const sortLabel = $('sort-by').selectedOptions[0].textContent;
    $('sort-help').textContent = `현재 목록: ${sortLabel} ${descending ? '내림차순 (큰 값·최근 날짜 먼저)' : '오름차순 (작은 값·이른 날짜 먼저)'}. 같은 값은 ID가 작은 순서, 미입력은 마지막입니다.`;
    const list = $('task-list'); list.replaceChildren(); $('list-count').textContent = visible.length;
    if (!visible.length) {
      const text = state.tasks.length ? '조건에 맞는 할 일이 없습니다.' : state.view === 'today' ? '오늘 예정된 할 일이 없습니다. 작은 일 하나부터 추가해보세요.' : '아직 할 일이 없습니다. 첫 할 일을 추가해보세요.';
      list.append(el('p', 'empty', text));
    }
    visible.forEach(task => {
      const row = el('article', 'task-row' + (task.status === 'DONE' ? ' is-done' : ''));
      const content = el('div', 'task-content'); const label = el('label', 'check-label');
      const checkbox = el('input', 'task-check'); checkbox.type = 'checkbox'; checkbox.checked = task.status === 'DONE'; checkbox.setAttribute('aria-label', `${task.title} ${checkbox.checked ? '미완료로 되돌리기' : '완료 처리'}`);
      checkbox.disabled = state.pendingTaskIds.has(task.id);
      label.append(checkbox, el('span', 'task-title', task.title)); content.append(label);
      const meta = el('div', 'task-meta'); meta.append(el('span', 'category', titleForPlan(task.plan_id)), el('span', '', `예상 ${task.expected_minutes}분`));
      if (state.view !== 'today') meta.append(el('span', '', task.scheduled_date));
      if (task.tag) meta.append(el('span', '', `#${task.tag}`));
      if (task.status !== 'DONE' && task.due_date && task.due_date < today) meta.append(el('span', 'late', '지연'));
      if (task.status === 'DONE') meta.append(el('span', '', '완료'));
      content.append(meta);
      const details = state.details.get(task.id);
      const links = el('div', 'task-links');
      if (details?.links?.length) {
        details.links.forEach(link => {
          // 기존 DB에 직접 들어간 주소도 확인하여 실행 가능한 URL을 막는다.
          try { const url = new URL(link.url); if (!['http:', 'https:'].includes(url.protocol)) return;
            const anchor = el('a', '', `↗ ${link.label}`); anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; links.append(anchor);
          } catch (_) { /* 잘못된 주소는 표시하지 않는다. */ }
        });
      }
      // 기존 링크가 없는 Task에서도 같은 위치에서 자료를 추가할 수 있다.
      const addLinkButton = el('button', 'task-add-link', '＋ 자료 링크');
      addLinkButton.type = 'button'; addLinkButton.setAttribute('aria-label', `${task.title} 자료 링크 추가`);
      addLinkButton.disabled = state.pendingTaskIds.has(task.id);
      addLinkButton.addEventListener('click', () => {
        if (state.pendingTaskIds.has(task.id)) return;
        linkTaskId = task.id; $('link-form').reset(); $('link-error').hidden = true;
        $('link-task-title').textContent = task.title; $('link-dialog').showModal();
      });
      links.append(addLinkButton); content.append(links);
      checkbox.addEventListener('change', async () => {
        if (state.pendingTaskIds.has(task.id)) return;
        state.pendingTaskIds.add(task.id);
        checkbox.disabled = true; deleteButton.disabled = true; editButton.disabled = true; recordButton.disabled = true; addLinkButton.disabled = true; const wasDone = task.status === 'DONE';
        try {
          const result = await api(`/tasks/${task.id}/${wasDone ? 'reopen' : 'complete'}`, { method: 'PATCH' });
          task.status = result.status; task.completed_at = result.completed_at;
          tell(wasDone ? '미완료로 되돌렸습니다.' : '할 일을 완료했습니다.');
          renderTasks(); await refreshSummaries(); renderPlans();
        } catch (error) { checkbox.checked = wasDone; failure(error.message); }
        finally { state.pendingTaskIds.delete(task.id); renderTasks(); }
      });
      const actions = el('div', 'task-actions');
      const recordButton = el('button', 'task-record', '기록');
      recordButton.type = 'button'; recordButton.setAttribute('aria-label', `${task.title} 실행 기록`);
      recordButton.disabled = state.pendingTaskIds.has(task.id);
      recordButton.addEventListener('click', () => { if (!state.pendingTaskIds.has(task.id)) openExecution(task); });
      const editButton = el('button', 'task-edit', '수정');
      editButton.type = 'button';
      editButton.setAttribute('aria-label', `${task.title} 수정`);
      editButton.disabled = state.pendingTaskIds.has(task.id);
      editButton.addEventListener('click', () => {
        if (!state.pendingTaskIds.has(task.id)) openTask(task);
      });
      const deleteButton = el('button', 'task-delete', '삭제');
      deleteButton.type = 'button';
      deleteButton.setAttribute('aria-label', `${task.title} 삭제`);
      deleteButton.disabled = state.pendingTaskIds.has(task.id);
      deleteButton.addEventListener('click', async () => {
        if (state.pendingTaskIds.has(task.id)) return;
        // 삭제 범위와 복구 불가를 먼저 알리고, 취소하면 API를 호출하지 않는다.
        if (!window.confirm(`“${task.title}” 할 일을 삭제할까요?\n연결된 자료 링크와 실행 기록도 함께 삭제되며 되돌릴 수 없습니다.`)) return;
        state.pendingTaskIds.add(task.id);
        deleteButton.disabled = true; checkbox.disabled = true; editButton.disabled = true; recordButton.disabled = true; addLinkButton.disabled = true;
        deleteButton.textContent = '삭제 중…';
        try {
          await api(`/tasks/${task.id}`, { method: 'DELETE' });
          // 서버 성공 후에만 화면에서 제거하고 시간·완료 집계를 다시 계산한다.
          state.tasks = state.tasks.filter(item => item.id !== task.id);
          state.details.delete(task.id);
          renderTasks();
          tell('할 일과 연결된 자료 링크·실행 기록을 삭제했습니다.');
          // 현재 화면과 Plan 집계도 서버에서 다시 읽어 실제 저장값과 맞춘다.
          await load();
        } catch (error) {
          // 서버가 실패하면 기존 Task를 유지하고 다시 시도할 수 있게 한다.
          failure(`삭제하지 못했습니다. ${error.message}`);
        } finally {
          state.pendingTaskIds.delete(task.id);
          renderTasks();
        }
      });
      actions.append(recordButton, editButton, deleteButton);
      row.append(content, actions); list.append(row);
    });
    const done = visible.filter(t => t.status === 'DONE').length;
    $('done-count').textContent = done; $('task-count').textContent = visible.length;
    $('expected-minutes').textContent = visible.reduce((sum, t) => sum + t.expected_minutes, 0);
    const missingActual = visible.some(t => !state.details.get(t.id)?.executions);
    $('actual-minutes').textContent = missingActual ? '—' : visible.reduce((sum, t) => sum + (state.details.get(t.id)?.executions || []).reduce((total, x) => total + (x.actual_minutes || 0), 0), 0);
    $('actual-caption').textContent = missingActual ? '일부 실행 기록을 불러오지 못했습니다.' : '직접 입력한 실행 기록 기준';
    const rate = visible.length ? Math.round(done / visible.length * 100) : 0;
    $('completion-bar').style.width = `${rate}%`; $('completion-label').textContent = visible.length ? `${rate}% 완료 · 한 걸음씩 이어가요` : '할 일을 추가해 시작해보세요';
  }
  async function refreshSummaries() {
    const results = await Promise.all(state.plans.map(async plan => { try { return [plan.id, await api(`/plans/${plan.id}/summary`)]; } catch (_) { return [plan.id, null]; } }));
    state.summaries = new Map(results);
  }
  async function load() {
    const generation = ++state.generation; $('task-list').setAttribute('aria-busy', 'true'); $('load-error').hidden = true;
    try {
      // 날짜별 메모는 Task 조회 실패나 전체 Task 개수와 무관하게 사용할 수 있다.
      if (state.view === 'notes') {
        renderChrome();
        document.dispatchEvent(new CustomEvent('aleph:data', { detail: { view: state.view, plans: state.plans } }));
        return;
      }
      const taskUrl = state.planId != null ? `/tasks?plan_id=${state.planId}` : state.view === 'today' ? '/tasks/today' : '/tasks';
      const [plans, tasks] = await Promise.all([api('/plans'), api(taskUrl)]);
      if (generation !== state.generation) return;
      state.plans = plans; state.tasks = tasks;
      const details = await Promise.all(tasks.map(async task => {
        const [links, executions] = await Promise.allSettled([api(`/tasks/${task.id}/links`), api(`/tasks/${task.id}/executions`)]);
        return [task.id, { links: links.status === 'fulfilled' ? links.value : null, executions: executions.status === 'fulfilled' ? executions.value : null }];
      }));
      if (generation !== state.generation) return;
      state.details = new Map(details); await refreshSummaries();
      if (generation !== state.generation) return;
      renderChrome(); renderPlans(); renderTasks();
      // 돌아보기 모듈은 화면 선택과 최신 Plan 목록을 받아 자체 집계를 조회한다.
      document.dispatchEvent(new CustomEvent('aleph:data', { detail: { view: state.view, plans: state.plans } }));
      if (details.some(([, detail]) => detail.links === null)) failure('일부 자료 링크를 불러오지 못했습니다. 새로고침해주세요.');
    } catch (error) { if (generation === state.generation) { failure(`데이터를 불러오지 못했습니다. ${error.message}`); $('task-list').replaceChildren(el('p', 'empty', '다시 시도 버튼으로 목록을 불러와주세요.')); } }
    finally { if (generation === state.generation) $('task-list').setAttribute('aria-busy', 'false'); }
  }
  function changeView(view, planId = null) { state.view = view; state.planId = planId; $('search').value = ''; $('status-filter').value = ''; renderChrome(); load(); }
  function openPlan(fromTask = false, plan = null) {
    state.planFromTask = fromTask === true;
    editingPlan = plan;
    const form = $('plan-form'); form.reset();
    form.querySelectorAll('[data-existing-priority]').forEach(option => option.remove());
    $('plan-dialog-title').textContent = plan ? '계획 수정' : '새로운 계획';
    $('plan-edit-help').hidden = !plan;
    form.querySelector('[type="submit"]').textContent = plan ? '변경 저장' : '계획 저장';
    if (plan) {
      if (![...form.elements.priority.options].some(option => option.value === plan.priority)) {
        const option = el('option', '', plan.priority); option.value = plan.priority; option.dataset.existingPriority = 'true'; form.elements.priority.append(option);
      }
      for (const key of ['title', 'description', 'category', 'start_date', 'end_date', 'priority', 'success_criteria', 'expected_minutes']) form.elements[key].value = plan[key] ?? '';
    }
    $('plan-error').hidden = true;
    // 기존 할 일 dialog를 닫지 않아 입력한 제목·날짜·내용을 보존한다.
    $('plan-dialog').showModal();
  }
  async function loadPlanHistory() {
    const request = ++historyRequest;
    const list = $('plan-history-list'); list.replaceChildren(el('p', 'field-help', '이력을 불러오는 중…'));
    $('plan-history-error').hidden = true;
    try {
      const rows = await api(`/plans/${historyPlanId}/versions`);
      // 다른 계획을 연 뒤 늦게 도착한 응답은 표시하지 않는다.
      if (request !== historyRequest) return;
      list.replaceChildren();
      if (!rows.length) list.append(el('p', 'empty', '아직 수정 이력이 없습니다. 계획을 수정하면 이전 내용이 남습니다.'));
      [...rows].reverse().forEach(row => {
        const item = el('article', 'execution-item');
        item.append(el('h3', '', `${row.version_no}번째 수정 전 · ${row.title}`));
        for (const [label, value] of [['기간', `${row.start_date} ~ ${row.end_date}`], ['카테고리', row.category], ['우선순위', row.priority], ['예상 시간', `${row.expected_minutes}분`], ['성공 기준', row.success_criteria], ['설명', row.description ?? '없음'], ['상태', row.status]]) item.append(el('p', 'execution-memo', `${label}: ${value}`));
        list.append(item);
      });
    } catch (error) {
      if (request !== historyRequest) return;
      list.replaceChildren(); $('plan-history-error').textContent = error.message; $('plan-history-error').hidden = false;
    }
  }
  $('plan-history-retry').addEventListener('click', loadPlanHistory);
  function openTask(task = null) {
    // 추가 버튼의 클릭 이벤트와 실제 Task 객체를 구분한다.
    const editing = task && Number.isInteger(task.id) ? task : null;
    state.editTaskId = editing?.id ?? null;
    const form = $('task-form');
    form.querySelectorAll('[data-existing-priority]').forEach(option => option.remove());
    form.reset(); $('task-error').hidden = true; renderPlans();
    $('task-dialog-title').textContent = editing ? '할 일 수정' : '새로운 할 일';
    form.querySelector('[type="submit"]').textContent = editing ? '변경 저장' : '할 일 저장';
    // 기존 수정 API는 Plan 재연결을 지원하지 않으므로 원래 계획을 유지한다.
    $('task-plan').disabled = Boolean(editing);
    $('task-new-plan').hidden = Boolean(editing);
    $('task-plan-help').textContent = editing ? '연결된 계획을 유지하며 할 일 내용을 수정합니다.' : '원하는 계획이 없으면 새로 만들 수 있습니다. 작성 중인 할 일은 유지됩니다.';
    if (editing) {
      $('task-plan').value = editing.plan_id;
      const priority = form.elements.priority;
      if (![...priority.options].some(option => option.value === editing.priority)) {
        const option = el('option', '', editing.priority); option.value = editing.priority;
        option.dataset.existingPriority = 'true'; priority.append(option);
      }
      for (const name of ['title', 'description', 'scheduled_date', 'due_date', 'priority', 'tag', 'expected_minutes']) {
        form.elements[name].value = editing[name] ?? '';
      }
    }
    $('task-dialog').showModal();
  }
  $('add-task').addEventListener('click', openTask); $('add-plan').addEventListener('click', openPlan);
  $('task-new-plan').addEventListener('click', () => openPlan(true));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
  $('search').addEventListener('input', renderTasks); $('status-filter').addEventListener('change', renderTasks);
  $('sort-by').addEventListener('change', renderTasks); $('sort-order').addEventListener('change', renderTasks);
  $('refresh').addEventListener('click', load); $('retry').addEventListener('click', load);
  document.addEventListener('aleph:open-execution', event => {
    const task = event.detail;
    if (task && Number.isInteger(task.id)) openExecution(task);
  });
  document.addEventListener('aleph:go-plan', event => { if (Number.isInteger(event.detail)) changeView('all', event.detail); });
  document.addEventListener('aleph:reload', load);

  function renderExecutionHistory(rows) {
    const list = $('execution-history'); list.replaceChildren();
    if (!rows.length) list.append(el('p', 'empty', '아직 실행 기록이 없습니다. 오늘의 실행을 남겨보세요.'));
    // API의 생성순 결과를 복사해 최근 기록부터 표시한다.
    [...rows].reverse().forEach(record => {
      const item = el('article', 'execution-item');
      const heading = el('div', 'execution-item-heading');
      heading.append(el('strong', '', record.actual_minutes == null ? '시간 미입력' : `실제 ${record.actual_minutes}분`), el('span', 'execution-time', (record.created_at || '').replace('T', ' ').slice(0, 16)));
      item.append(heading);
      if (record.started_at || record.ended_at) {
        const format = value => value ? value.replace('T', ' ').slice(0, 19) : '미입력';
        item.append(el('p', 'execution-time', `${format(record.started_at)} → ${format(record.ended_at)}`));
      }
      if (record.memo) item.append(el('p', 'execution-memo', record.memo));
      if (record.blocked_reason?.trim()) item.append(el('p', 'execution-reason', `막힌 이유: ${record.blocked_reason}`));
      list.append(item);
    });
  }
  async function loadExecutionHistory() {
    const taskId = executionTaskId; if (taskId == null) return;
    const request = ++executionHistoryRequest;
    $('execution-history').setAttribute('aria-busy', 'true');
    $('execution-history-error').hidden = true;
    try {
      const rows = await api(`/tasks/${taskId}/executions`);
      // 대화상자를 다른 Task로 연 경우 늦게 도착한 이전 기록은 표시하지 않는다.
      if (request !== executionHistoryRequest || taskId !== executionTaskId) return;
      state.details.set(taskId, { ...state.details.get(taskId), executions: rows });
      renderExecutionHistory(rows); renderTasks();
    } catch (error) {
      if (request === executionHistoryRequest) {
        $('execution-history-error').textContent = `기록을 불러오지 못했습니다. ${error.message}`;
        $('execution-history-error').hidden = false;
      }
    } finally {
      if (request === executionHistoryRequest) $('execution-history').setAttribute('aria-busy', 'false');
    }
  }
  function openExecution(task) {
    if (executionPending) return;
    executionTaskId = task.id;
    $('execution-form').reset(); $('execution-error').hidden = true; $('execution-status').hidden = true;
    $('execution-task-title').textContent = task.title;
    $('execution-history').replaceChildren(el('p', 'empty', '실행 기록을 불러오는 중…'));
    $('execution-dialog').showModal(); loadExecutionHistory();
  }
  $('execution-history-retry').addEventListener('click', loadExecutionHistory);
  $('execution-dialog').addEventListener('cancel', event => { if (executionPending) event.preventDefault(); });
  $('execution-form').addEventListener('submit', async event => {
    event.preventDefault(); if (executionPending || executionTaskId == null) return;
    const form = $('execution-form'); const errorBox = $('execution-error');
    errorBox.hidden = true; $('execution-status').hidden = true;
    const values = Object.fromEntries(new FormData(form));
    // 빈 입력과 실제 0분을 구분해, 비운 시간은 NULL로 저장한다.
    const actual = values.actual_minutes === '' ? null : Number(values.actual_minutes);
    if (actual != null && (!Number.isInteger(actual) || actual < 0)) {
      errorBox.textContent = '실제 시간은 0 이상의 정수로 입력해주세요.'; errorBox.hidden = false; return;
    }
    if (values.started_at && values.ended_at && new Date(values.ended_at) < new Date(values.started_at)) {
      errorBox.textContent = '종료 시각은 시작 시각보다 빠를 수 없습니다.'; errorBox.hidden = false; return;
    }
    const payload = { actual_minutes: actual, started_at: values.started_at || null, ended_at: values.ended_at || null, memo: values.memo.trim() || null, blocked_reason: values.blocked_reason.trim() || null };
    if (Object.values(payload).every(value => value == null)) {
      errorBox.textContent = '시간, 메모, 막힌 이유 중 한 가지 이상을 기록해주세요.'; errorBox.hidden = false; return;
    }
    executionPending = true; const taskId = executionTaskId;
    state.pendingTaskIds.add(taskId); renderTasks();
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = '저장 중…';
    form.querySelectorAll('[data-close]').forEach(button => { button.disabled = true; });
    try {
      await api(`/tasks/${taskId}/executions`, { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      $('execution-status').textContent = '실행 기록을 저장했습니다. 할 일의 완료 상태는 유지됩니다.';
      $('execution-status').hidden = false;
      // 목록/Plan 통계와 기록 이력을 다시 읽는다. 조회 실패를 저장 실패로 오인하지 않는다.
      await load(); await loadExecutionHistory();
    } catch (error) {
      errorBox.textContent = `기록을 저장하지 못했습니다. ${error.message}`; errorBox.hidden = false;
    } finally {
      executionPending = false; state.pendingTaskIds.delete(taskId); renderTasks();
      submit.disabled = false; submit.textContent = '기록 저장';
      form.querySelectorAll('[data-close]').forEach(button => { button.disabled = false; });
    }
  });

  // 입력 중에는 제출 버튼을 잠가 더블 클릭으로 인한 중복 요청을 방지한다.
  function connectForm(formId, dialogId, errorId, path, build, onSaved) {
    const form = $(formId); let pending = false;
    // 저장 중 대화상자를 닫아 다른 초안과 저장 결과가 섞이는 일을 방지한다.
    $(dialogId).addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending) return;
      const errorBox = $(errorId); errorBox.hidden = true;
      try {
        const values = Object.fromEntries(new FormData(form)); const payload = build(values);
        pending = true; const button = form.querySelector('[type="submit"]'); const label = button.textContent; button.disabled = true; button.textContent = '저장 중…';
        try {
          const request = typeof path === 'function' ? path() : { path, method: 'POST' };
          form.querySelectorAll('[data-close]').forEach(button => { button.disabled = true; });
          const saved = await api(request.path, { method: request.method, body: JSON.stringify(payload) });
          if (!saved?.id) throw new Error('저장 결과를 확인할 수 없습니다.');
          $(dialogId).close(); form.reset(); onSaved(saved, payload); await load();
        } finally { pending = false; button.disabled = false; button.textContent = label; form.querySelectorAll('[data-close]').forEach(close => { close.disabled = false; }); }
      } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    });
  }
  connectForm('task-form', 'task-dialog', 'task-error', () => state.editTaskId == null ? { path: '/tasks', method: 'POST' } : { path: `/tasks/${state.editTaskId}`, method: 'PUT' }, values => {
    if (!values.title.trim()) throw new Error('할 일 제목을 입력해주세요.');
    const payload = { ...values, title: values.title.trim(), expected_minutes: Number(values.expected_minutes), due_date: values.due_date || null, description: values.description || null, tag: values.tag || null };
    if (state.editTaskId == null) payload.plan_id = Number(values.plan_id);
    return payload;
  }, (saved, payload) => {
    const wasEditing = state.editTaskId != null;
    const planId = saved.plan_id ?? payload.plan_id;
    state.editTaskId = null;
    if (state.view === 'plans' || (state.planId != null && state.planId !== planId)) { state.view = 'all'; state.planId = planId; }
    if (state.view === 'today' && payload.scheduled_date !== today) { state.view = 'all'; state.planId = planId; }
    $('search').value = ''; $('status-filter').value = ''; tell(wasEditing ? '할 일 변경 내용을 저장했습니다.' : '할 일을 저장했습니다.');
  });
  connectForm('plan-form', 'plan-dialog', 'plan-error', () => editingPlan ? { path: `/plans/${editingPlan.id}`, method: 'PUT' } : { path: '/plans', method: 'POST' }, values => {
    if (!values.title.trim() || !values.category.trim() || !values.success_criteria.trim()) throw new Error('제목, 카테고리, 성공 기준을 입력해주세요.');
    if (values.end_date < values.start_date) throw new Error('종료일은 시작일보다 빠를 수 없습니다.');
    return { ...values, title: values.title.trim(), category: values.category.trim(), expected_minutes: Number(values.expected_minutes), description: values.description || null, ...(editingPlan ? { status: editingPlan.status } : {}) };
  }, saved => {
    if (state.planFromTask) {
      state.pendingTaskPlanId = saved.id;
      tell('새 계획을 만들었습니다. 작성 중인 할 일에 자동으로 선택됩니다.');
    } else tell(editingPlan ? '계획을 수정했습니다. 이전 내용은 수정 이력에서 확인할 수 있습니다.' : '계획을 저장했습니다. 이제 할 일을 추가해보세요.');
    editingPlan = null;
    state.planFromTask = false;
  });
  connectForm('link-form', 'link-dialog', 'link-error', () => ({ path: `/tasks/${linkTaskId}/links`, method: 'POST' }), values => {
    const label = values.label.trim();
    if (!label) throw new Error('자료의 표시 이름을 입력해주세요.');
    let url;
    try { url = new URL(values.url.trim()); } catch (_) { throw new Error('http:// 또는 https://로 시작하는 올바른 주소를 입력해주세요.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http 또는 https 주소만 저장할 수 있습니다.');
    // 화면에서 1차 검사하고, 서버의 HttpUrl 검증도 그대로 통과해야 저장된다.
    return { label, url: url.href, link_type: 'web' };
  }, () => tell('자료 링크를 저장했습니다. 할 일 아래에서 열 수 있습니다.'));
  load();
})();
