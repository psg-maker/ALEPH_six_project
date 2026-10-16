/* 화면은 기존 API만 호출한다. 사용자 입력은 innerHTML 대신 textContent로 표시한다. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { view: 'today', planId: null, plans: [], tasks: [], summaries: new Map(), details: new Map(), generation: 0 };
  const today = document.body.dataset.today;
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
    const title = state.planId != null ? titleForPlan(state.planId) : { today: '오늘, 한 걸음 더.', all: '나의 모든 할 일', plans: '작은 목표, 꾸준한 실행.' }[state.view];
    $('page-title').textContent = title;
    $('breadcrumb').textContent = state.planId != null ? '계획별 할 일' : { today: '오늘', all: '전체 할 일', plans: '나의 계획' }[state.view];
    $('list-title').textContent = state.planId != null ? '계획의 할 일' : state.view === 'today' ? '오늘의 체크리스트' : '전체 체크리스트';
    $('page-caption').textContent = state.view === 'plans' ? '내가 정한 목표와 진행 상황을 한눈에.' : '계획을 실행으로 바꾸는 작은 체크.';
    document.body.classList.toggle('plans-view', state.view === 'plans');
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
      const track = el('div', 'progress-track'); const fill = el('span'); fill.style.width = `${summary?.completion_rate || 0}%`; track.append(fill); card.append(meta, track); list.append(card);
    });
    const select = $('task-plan'); const previous = select.value; select.replaceChildren();
    state.plans.forEach(plan => { const option = el('option', '', plan.title); option.value = plan.id; select.append(option); });
    if (state.planId != null) select.value = state.planId; else if (previous && state.plans.some(p => String(p.id) === previous)) select.value = previous;
  }

  function renderTasks() {
    const keyword = $('search').value.trim().toLocaleLowerCase(); const status = $('status-filter').value;
    const visible = state.tasks.filter(task => (!status || task.status === status) && (!keyword || `${task.title} ${task.description || ''}`.toLocaleLowerCase().includes(keyword)));
    const list = $('task-list'); list.replaceChildren(); $('list-count').textContent = visible.length;
    if (!visible.length) {
      const text = state.tasks.length ? '조건에 맞는 할 일이 없습니다.' : state.view === 'today' ? '오늘 예정된 할 일이 없습니다. 작은 일 하나부터 추가해보세요.' : '아직 할 일이 없습니다. 첫 할 일을 추가해보세요.';
      list.append(el('p', 'empty', text));
    }
    visible.forEach(task => {
      const row = el('article', 'task-row' + (task.status === 'DONE' ? ' is-done' : ''));
      const content = el('div', 'task-content'); const label = el('label', 'check-label');
      const checkbox = el('input', 'task-check'); checkbox.type = 'checkbox'; checkbox.checked = task.status === 'DONE'; checkbox.setAttribute('aria-label', `${task.title} ${checkbox.checked ? '미완료로 되돌리기' : '완료 처리'}`);
      label.append(checkbox, el('span', 'task-title', task.title)); content.append(label);
      const meta = el('div', 'task-meta'); meta.append(el('span', 'category', titleForPlan(task.plan_id)), el('span', '', `예상 ${task.expected_minutes}분`));
      if (state.view !== 'today') meta.append(el('span', '', task.scheduled_date));
      if (task.tag) meta.append(el('span', '', `#${task.tag}`));
      if (task.status !== 'DONE' && task.due_date && task.due_date < today) meta.append(el('span', 'late', '지연'));
      if (task.status === 'DONE') meta.append(el('span', '', '완료'));
      content.append(meta);
      const details = state.details.get(task.id);
      if (details?.links?.length) {
        const links = el('div', 'task-links');
        details.links.forEach(link => {
          // 기존 DB에 직접 들어간 주소도 확인하여 실행 가능한 URL을 막는다.
          try { const url = new URL(link.url); if (!['http:', 'https:'].includes(url.protocol)) return;
            const anchor = el('a', '', `↗ ${link.label}`); anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; links.append(anchor);
          } catch (_) { /* 잘못된 주소는 표시하지 않는다. */ }
        }); content.append(links);
      }
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true; const wasDone = task.status === 'DONE';
        try {
          const result = await api(`/tasks/${task.id}/${wasDone ? 'reopen' : 'complete'}`, { method: 'PATCH' });
          task.status = result.status; task.completed_at = result.completed_at;
          tell(wasDone ? '미완료로 되돌렸습니다.' : '할 일을 완료했습니다.');
          renderTasks(); await refreshSummaries(); renderPlans();
        } catch (error) { checkbox.checked = wasDone; checkbox.disabled = false; failure(error.message); }
      });
      row.append(content); list.append(row);
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
      if (details.some(([, detail]) => detail.links === null)) failure('일부 자료 링크를 불러오지 못했습니다. 새로고침해주세요.');
    } catch (error) { if (generation === state.generation) { failure(`데이터를 불러오지 못했습니다. ${error.message}`); $('task-list').replaceChildren(el('p', 'empty', '다시 시도 버튼으로 목록을 불러와주세요.')); } }
    finally { if (generation === state.generation) $('task-list').setAttribute('aria-busy', 'false'); }
  }
  function changeView(view, planId = null) { state.view = view; state.planId = planId; $('search').value = ''; $('status-filter').value = ''; renderChrome(); load(); }
  function openPlan() { $('plan-error').hidden = true; $('plan-dialog').showModal(); }
  function openTask() {
    if (!state.plans.length) { tell('먼저 할 일을 연결할 계획을 만들어주세요.'); openPlan(); return; }
    $('task-error').hidden = true; renderPlans(); $('task-dialog').showModal();
  }
  $('add-task').addEventListener('click', openTask); $('add-plan').addEventListener('click', openPlan);
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
  $('search').addEventListener('input', renderTasks); $('status-filter').addEventListener('change', renderTasks);
  $('refresh').addEventListener('click', load); $('retry').addEventListener('click', load);

  // 입력 중에는 제출 버튼을 잠가 더블 클릭으로 인한 중복 요청을 방지한다.
  function connectForm(formId, dialogId, errorId, path, build, onSaved) {
    const form = $(formId); let pending = false;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending) return;
      const errorBox = $(errorId); errorBox.hidden = true;
      try {
        const values = Object.fromEntries(new FormData(form)); const payload = build(values);
        pending = true; const button = form.querySelector('[type="submit"]'); const label = button.textContent; button.disabled = true; button.textContent = '저장 중…';
        try {
          const saved = await api(path, { method: 'POST', body: JSON.stringify(payload) });
          if (!saved?.id) throw new Error('저장 결과를 확인할 수 없습니다.');
          $(dialogId).close(); form.reset(); onSaved(saved, payload); await load();
        } finally { pending = false; button.disabled = false; button.textContent = label; }
      } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    });
  }
  connectForm('task-form', 'task-dialog', 'task-error', '/tasks', values => {
    if (!values.title.trim()) throw new Error('할 일 제목을 입력해주세요.');
    return { ...values, title: values.title.trim(), plan_id: Number(values.plan_id), expected_minutes: Number(values.expected_minutes), due_date: values.due_date || null, description: values.description || null, tag: values.tag || null };
  }, (saved, payload) => {
    if (state.view === 'plans' || (state.planId != null && state.planId !== payload.plan_id)) { state.view = 'all'; state.planId = payload.plan_id; }
    if (state.view === 'today' && payload.scheduled_date !== today) { state.view = 'all'; state.planId = payload.plan_id; }
    $('search').value = ''; $('status-filter').value = ''; tell('할 일을 저장했습니다.');
  });
  connectForm('plan-form', 'plan-dialog', 'plan-error', '/plans', values => {
    if (!values.title.trim() || !values.category.trim() || !values.success_criteria.trim()) throw new Error('제목, 카테고리, 성공 기준을 입력해주세요.');
    if (values.end_date < values.start_date) throw new Error('종료일은 시작일보다 빠를 수 없습니다.');
    return { ...values, title: values.title.trim(), category: values.category.trim(), expected_minutes: Number(values.expected_minutes), description: values.description || null };
  }, () => tell('계획을 저장했습니다. 이제 할 일을 추가해보세요.'));
  load();
})();
