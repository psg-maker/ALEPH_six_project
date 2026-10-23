/* 집계 카드와 근거 조회를 담당한다. 저장/변경은 기존 Task 화면에 맡긴다. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let plans = [], summary = null, metric = 'task_count', generation = 0, evidenceGeneration = 0;
  // 입력 중인 날짜와 실제 적용된 범위를 분리해 숫자와 근거가 어긋나지 않게 한다.
  let appliedPeriod = { start: '', end: '' };
  const titles = { task_count: '전체 할 일', completed_task_count: '완료한 할 일', overdue_task_count: '지연된 할 일', blocked_task_count: '막힌 이유가 있는 할 일', expected_minutes: '예상 시간의 근거', actual_minutes: '실제 시간의 근거', difference_minutes: '시간 차이의 근거' };
  function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; }
  async function get(path) {
    const response = await fetch(path); const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '기록을 불러오지 못했습니다.');
    return data;
  }
  const selectedId = () => Number($('insight-plan').value);
  function withPeriod(path, period = appliedPeriod) {
    const params = new URLSearchParams();
    if (period.start) params.set('start_date', period.start);
    if (period.end) params.set('end_date', period.end);
    return params.size ? path + (path.includes('?') ? '&' : '?') + params : path;
  }
  function setTotal(value, text) { $('insight-evidence-total').dataset.total = value; $('insight-evidence-total').textContent = text; }
  function recordButton(task) {
    const button = el('button', 'secondary evidence-open-record', '실행 기록 보기'); button.type = 'button';
    button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('aleph:open-execution', { detail: task })));
    return button;
  }
  function taskRows(tasks, reasons = []) {
    tasks.forEach(task => {
      const row = el('article', 'evidence-task'); row.dataset.taskId = task.id;
      const text = el('div', 'evidence-content'); text.append(el('strong', '', task.title));
      text.append(el('p', 'execution-time', `#${task.id} · ${task.status === 'DONE' ? '완료' : '미완료'} · 예정 ${task.scheduled_date} · 마감 ${task.due_date || '없음'} · 예상 ${task.expected_minutes}분`));
      reasons.filter(r => r.task_id === task.id && r.blocked_reason?.trim()).forEach(r => text.append(el('p', 'execution-reason', r.blocked_reason)));
      row.append(text, recordButton(task)); $('insight-evidence').append(row);
    });
  }
  function executionRows(executions, tasks) {
    executions.forEach(record => {
      const row = el('article', 'evidence-execution'); const task = tasks.find(t => t.id === record.task_id);
      const text = el('div', 'evidence-content'); text.append(el('strong', '', task?.title || `Task ${record.task_id}`));
      text.append(el('p', 'execution-time', `실행 #${record.id} · Task #${record.task_id} · 실제 ${record.actual_minutes == null ? '시간 미입력' : record.actual_minutes + '분'} · ${(record.created_at || '').replace('T', ' ').slice(0, 16)}`));
      if (record.memo) text.append(el('p', 'execution-memo', record.memo));
      if (record.blocked_reason?.trim()) text.append(el('p', 'execution-reason', `막힌 이유: ${record.blocked_reason}`));
      row.append(text); if (task) row.append(recordButton(task)); $('insight-evidence').append(row);
    });
  }
  async function showEvidence(nextMetric = metric) {
    metric = nextMetric; if (!summary) return;
    const planId = selectedId(), request = ++evidenceGeneration;
    const list = $('insight-evidence'); list.dataset.metric = ''; list.setAttribute('aria-busy', 'true');
    list.replaceChildren(el('p', 'empty', '근거 기록을 불러오는 중…')); $('insight-evidence-error').hidden = true;
    $('insight-evidence-total').textContent = ''; $('insight-evidence-total').removeAttribute('data-total');
    $('insight-evidence-title').textContent = titles[metric];
    document.querySelectorAll('#insight-cards [data-metric]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.metric === metric)));
    const requestedMetric = metric, expected = summary[metric];
    try {
      const params = new URLSearchParams({ plan_id: planId });
      if (requestedMetric === 'completed_task_count') params.set('status', 'DONE');
      if (requestedMetric === 'overdue_task_count') params.set('overdue_only', 'true');
      if (requestedMetric === 'blocked_task_count') params.set('blocked_only', 'true');
      const needsExecutions = ['actual_minutes', 'difference_minutes', 'blocked_task_count'].includes(requestedMetric);
      const [tasks, executions] = await Promise.all([get(withPeriod('/tasks?' + params)), needsExecutions ? get(withPeriod(`/plans/${planId}/executions`)) : Promise.resolve([])]);
      if (request !== evidenceGeneration || planId !== selectedId() || $('insights-view').hidden) return;
      list.replaceChildren();
      let total;
      if (requestedMetric.endsWith('_count')) {
        total = tasks.length; taskRows(tasks, requestedMetric === 'blocked_task_count' ? executions : []);
        setTotal(total, `${total}개의 할 일 · 같은 할 일은 한 번만 표시합니다.`);
      } else if (requestedMetric === 'expected_minutes') {
        total = tasks.reduce((sum, task) => sum + task.expected_minutes, 0); taskRows(tasks);
        setTotal(total, `예상 ${total}분 = 아래 ${tasks.length}개 할 일의 예상 시간 합계`);
      } else {
        const actual = executions.reduce((sum, r) => sum + (r.actual_minutes || 0), 0);
        const expectedTime = tasks.reduce((sum, task) => sum + task.expected_minutes, 0);
        total = requestedMetric === 'actual_minutes' ? actual : actual - expectedTime;
        if (requestedMetric === 'difference_minutes') {
          setTotal(total, `차이 ${total}분 = 실제 ${actual}분 − 예상 ${expectedTime}분`);
          list.append(el('h3', 'evidence-section-title', '예상 시간 · 할 일')); taskRows(tasks);
          list.append(el('h3', 'evidence-section-title', '실제 시간 · 실행 기록'));
        } else setTotal(total, `실제 ${actual}분 = 실행 기록 ${executions.length}건의 시간 합계 · 미입력은 0분으로 집계`);
        executionRows(executions, tasks);
      }
      if (!tasks.length && !executions.length) list.append(el('p', 'empty', '아직 해당하는 기록이 없습니다.'));
      if (total !== expected) {
        $('insight-evidence-error').textContent = '조회 중 데이터가 변경되어 집계와 근거가 달라졌습니다. 집계 새로고침을 눌러주세요.';
        $('insight-evidence-error').hidden = false;
      }
      list.dataset.metric = requestedMetric;
    } catch (error) {
      if (request === evidenceGeneration) { list.replaceChildren(); $('insight-evidence-error').textContent = error.message; $('insight-evidence-error').hidden = false; }
    } finally { if (request === evidenceGeneration) list.setAttribute('aria-busy', 'false'); }
  }
  async function refresh() {
    const planId = selectedId(), request = ++generation; ++evidenceGeneration;
    summary = null; $('insight-error').hidden = true; $('insight-evidence-error').hidden = true;
    $('insight-evidence').dataset.metric = ''; $('insight-evidence').replaceChildren(); $('insight-evidence').setAttribute('aria-busy', 'false');
    $('insight-evidence-total').textContent = ''; $('insight-evidence-total').removeAttribute('data-total');
    document.querySelectorAll('#insight-cards [data-metric]').forEach(b => { b.disabled = true; b.querySelector('.insight-number').textContent = '—'; });
    $('insight-rate').textContent = '—'; $('insight-rate-bar').style.width = '0%';
    $('insight-rate-open').disabled = true;
    if (!planId) { document.dispatchEvent(new CustomEvent('aleph:review-plan', { detail: { plan: null, plans } })); $('insight-evidence').append(el('p', 'empty', '나의 계획에서 첫 계획을 만들어주세요.')); return; }
    const plan = plans.find(p => p.id === planId);
    document.dispatchEvent(new CustomEvent('aleph:review-plan', { detail: { plan, plans } }));
    const range = appliedPeriod.start || appliedPeriod.end ? `예정일 ${appliedPeriod.start || '처음'} ~ ${appliedPeriod.end || '마지막'} (시작·종료일 포함)` : '전체 기록';
    $('insight-scope').textContent = `집계 범위: ${plan?.title || ''}의 ${range}. 대상 할 일에 연결된 모든 실행 기록을 포함하며 실행일은 제한하지 않습니다. 완료는 현재 상태, 지연은 오늘 기준입니다. 숫자를 눌러 근거를 확인하세요.`;
    try {
      const data = await get(withPeriod(`/plans/${planId}/summary`));
      if (request !== generation || planId !== selectedId() || $('insights-view').hidden) return;
      summary = data;
      document.querySelectorAll('#insight-cards [data-metric]').forEach(b => { b.querySelector('.insight-number').textContent = data[b.dataset.metric]; b.disabled = false; });
      $('insight-rate').textContent = `${data.completion_rate}%`; $('insight-rate-bar').style.width = `${data.completion_rate}%`;
      $('insight-rate-open').disabled = false;
      await showEvidence();
    } catch (error) { if (request === generation) { $('insight-error').textContent = error.message; $('insight-error').hidden = false; } }
  }
  $('insight-plan').addEventListener('change', () => { metric = 'task_count'; refresh(); });
  $('insight-period-form').addEventListener('submit', event => {
    event.preventDefault();
    const start = $('insight-start-date'), end = $('insight-end-date');
    if (!start.checkValidity() || !end.checkValidity() || (start.value && end.value && start.value > end.value)) {
      $('insight-period-error').textContent = '올바른 날짜를 입력하고, 종료일을 시작일과 같거나 이후로 선택해주세요. 기존 집계 범위는 유지됩니다.';
      $('insight-period-error').hidden = false;
      return;
    }
    $('insight-period-error').hidden = true;
    appliedPeriod = { start: start.value, end: end.value };
    refresh();
  });
  $('insight-all-period').addEventListener('click', () => {
    $('insight-start-date').value = ''; $('insight-end-date').value = '';
    $('insight-period-error').hidden = true;
    appliedPeriod = { start: '', end: '' };
    refresh();
  });
  $('insight-refresh').addEventListener('click', refresh);
  $('insight-rate-open').addEventListener('click', () => showEvidence('completed_task_count'));
  document.querySelectorAll('#insight-cards [data-metric]').forEach(b => b.addEventListener('click', () => showEvidence(b.dataset.metric)));
  document.addEventListener('aleph:data', event => {
    if (event.detail.view !== 'insights') { ++generation; ++evidenceGeneration; return; }
    plans = event.detail.plans;
    const select = $('insight-plan'), previous = select.value; select.replaceChildren();
    plans.forEach(plan => { const option = el('option', '', plan.title); option.value = plan.id; select.append(option); });
    if (plans.some(plan => String(plan.id) === previous)) select.value = previous;
    refresh();
  });
})();
