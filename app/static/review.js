/* 회고 입력과 다음 계획 미리보기. 기존 API를 사용해 저장하고 연결한다. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('review-form'), nextForm = $('next-plan-form');
  const fields = ['reflection', 'improvement', 'next_action'];
  let source = null, plans = [], review = null, loaded = false, loading = false;
  let reviewSaving = false, nextSaving = false, requestId = 0, createdNext = null;
  const drafts = new Map();
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) {
      const detail = data?.detail;
      const message = Array.isArray(detail) ? detail.map(e => e.msg).join(' / ') : typeof detail === 'string' ? detail : detail?.message || '요청을 처리하지 못했습니다.';
      const error = new Error(message); error.status = response.status; throw error;
    }
    return data;
  }
  const values = () => Object.fromEntries(fields.map(name => [name, form.elements[name].value]));
  const dirty = () => fields.some(name => form.elements[name].value !== (review?.[name] || ''));
  function error(message) { $('review-error').textContent = message; $('review-error').hidden = false; }
  function controls() {
    form.querySelectorAll('textarea,button').forEach(n => { n.disabled = !loaded || loading || reviewSaving || nextSaving; });
    $('review-retry').disabled = reviewSaving || nextSaving || loading;
    $('next-plan-open').disabled = !loaded || loading || reviewSaving || nextSaving;
    $('next-plan-open').hidden = Boolean(review?.next_plan_id);
    $('review-next-link').hidden = !review?.next_plan_id;
    $('review-next-link').disabled = reviewSaving || nextSaving;
    if (review?.next_plan_id) {
      const title = plans.find(p => p.id === review.next_plan_id)?.title || (createdNext?.id === review.next_plan_id ? createdNext.title : `계획 #${review.next_plan_id}`);
      $('review-next-link').textContent = `다음 계획 열기: ${title}`;
    }
    $('review-draft-label').hidden = !loaded || !dirty();
    form.querySelector('[type=submit]').textContent = reviewSaving ? '저장 중…' : '회고 저장';
  }
  async function loadReview() {
    if (!source) return;
    const planId = source.id, token = ++requestId;
    loading = true; loaded = false; review = null; form.reset(); controls();
    $('review-error').hidden = true; $('review-status').hidden = true;
    $('review-load-state').textContent = '회고를 불러오는 중…';
    try {
      const result = await api(`/plans/${planId}/review`);
      if (token !== requestId || planId !== source?.id) return;
      review = result; loaded = true;
      const content = drafts.get(planId) || result || {};
      fields.forEach(name => { form.elements[name].value = content[name] || ''; });
      $('review-load-state').textContent = result ? '저장된 회고입니다. 내용을 수정해 다시 저장할 수 있습니다.' : '아직 회고를 작성하지 않았습니다. 한 줄부터 남겨보세요.';
    } catch (e) { if (token === requestId) { error(e.message); $('review-load-state').textContent = '회고를 다시 읽은 뒤 저장해주세요.'; } }
    finally { if (token === requestId) { loading = false; controls(); } }
  }
  document.addEventListener('aleph:review-plan', event => {
    const next = event.detail.plan; plans = event.detail.plans || [];
    if (source?.id === next?.id && loaded) { source = next; controls(); return; }
    if (source && loaded && dirty()) drafts.set(source.id, values());
    source = next; ++requestId;
    $('review-panel').hidden = !source; $('review-panel').dataset.planId = source?.id || '';
    if (source) loadReview(); else { loaded = false; review = null; form.reset(); controls(); }
  });
  form.addEventListener('input', () => {
    if (source) drafts.set(source.id, values());
    $('review-status').hidden = true; controls();
  });
  $('review-retry').addEventListener('click', () => { if (source && loaded && dirty()) drafts.set(source.id, values()); loadReview(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!source || !loaded || reviewSaving || nextSaving) return;
    const id = source.id;
    const payload = { ...values(), next_plan_id: review?.next_plan_id ?? null };
    reviewSaving = true; $('review-error').hidden = true; $('review-status').hidden = true; controls();
    try {
      const saved = await api(`/plans/${id}/review`, { method: 'PUT', body: JSON.stringify(payload) });
      drafts.delete(id);
      if (source?.id !== id) return;
      review = saved; fields.forEach(name => { form.elements[name].value = saved[name] || ''; });
      $('review-status').textContent = '회고를 저장했습니다.'; $('review-status').hidden = false;
      $('review-load-state').textContent = '저장된 회고입니다. 고칠 점을 다음 계획으로 이어갈 수 있습니다.';
    } catch (e) { if (source?.id === id) error(e.message); }
    finally { reviewSaving = false; controls(); }
  });
  function preview() {
    const parts = [], description = nextForm.elements.description.value;
    if (description) parts.push(description);
    if (review?.improvement?.trim()) parts.push(`이전 계획에서 가져온 개선점:\n${review.improvement.trim()}`);
    if (review?.next_action?.trim()) parts.push(`다음 실천:\n${review.next_action.trim()}`);
    $('next-plan-preview').textContent = parts.join('\n\n');
  }
  $('next-plan-open').addEventListener('click', () => {
    $('review-error').hidden = true;
    if (!loaded || !source) return;
    if (dirty()) { error('변경한 회고를 먼저 저장해주세요.'); return; }
    if (!review?.improvement?.trim()) { error('다음 계획에 반영할 고칠 점을 작성하고 저장해주세요.'); return; }
    if (review.next_plan_id) return;
    nextForm.reset(); nextForm.querySelectorAll('[data-existing-priority]').forEach(n => n.remove());
    const date = document.body.dataset.today;
    const end = new Date(date + 'T12:00:00'); end.setDate(end.getDate() + 7);
    const endDate = [end.getFullYear(), String(end.getMonth()+1).padStart(2,'0'), String(end.getDate()).padStart(2,'0')].join('-');
    const priority = nextForm.elements.priority;
    if (![...priority.options].some(o => o.value === source.priority)) { const option = document.createElement('option'); option.value = source.priority; option.textContent = source.priority; option.dataset.existingPriority = 'true'; priority.append(option); }
    const defaults = { title: `${source.title} · 다음 계획`.slice(0,200), category: source.category, priority: source.priority, start_date: date, end_date: endDate, expected_minutes: source.expected_minutes, success_criteria: source.success_criteria, description: '' };
    Object.entries(defaults).forEach(([name,value]) => { nextForm.elements[name].value = value; });
    $('next-plan-error').hidden = true; preview(); $('next-plan-dialog').showModal();
  });
  nextForm.addEventListener('input', preview);
  $('review-next-link').addEventListener('click', () => { if (review?.next_plan_id) document.dispatchEvent(new CustomEvent('aleph:go-plan', { detail: review.next_plan_id })); });
  $('next-plan-dialog').addEventListener('cancel', e => { if (nextSaving) e.preventDefault(); });
  nextForm.addEventListener('submit', async event => {
    event.preventDefault(); if (nextSaving || !source || !review) return;
    const id = source.id, v = Object.fromEntries(new FormData(nextForm));
    const box = $('next-plan-error'); box.hidden = true;
    if (!v.title.trim() || !v.category.trim() || !v.success_criteria.trim()) { box.textContent = '제목·카테고리·성공 기준을 입력해주세요.'; box.hidden = false; return; }
    if (v.end_date < v.start_date || !Number.isInteger(Number(v.expected_minutes)) || Number(v.expected_minutes) < 0) { box.textContent = '날짜 순서와 0 이상의 정수 시간을 확인해주세요.'; box.hidden = false; return; }
    const payload = { ...v, title: v.title.trim(), category: v.category.trim(), expected_minutes: Number(v.expected_minutes), description: v.description || null };
    nextSaving = true; controls();
    nextForm.querySelectorAll('button').forEach(b => { b.disabled = true; }); nextForm.querySelector('[type=submit]').textContent = '생성 중…';
    try {
      const saved = await api(`/plans/${id}/next-plan`, { method: 'POST', body: JSON.stringify(payload) });
      createdNext = { id: saved.next_plan_id, title: saved.title };
      if (source?.id === id) { review.next_plan_id = saved.next_plan_id; $('review-status').textContent = '개선점을 담은 다음 계획을 만들고 연결했습니다.'; $('review-status').hidden = false; }
      $('next-plan-dialog').close(); document.dispatchEvent(new Event('aleph:reload'));
    } catch (e) {
      box.textContent = e.message; box.hidden = false;
      if (e.status === 409) { await loadReview(); if (review?.next_plan_id) $('next-plan-dialog').close(); }
    } finally { nextSaving = false; nextForm.querySelectorAll('button').forEach(b => { b.disabled = false; }); nextForm.querySelector('[type=submit]').textContent = '다음 계획 생성'; controls(); }
  });
})();
