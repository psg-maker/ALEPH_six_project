/* 날짜별 메모는 기존 GET/PUT API로 저장하며 초안은 현재 페이지에서만 보관한다. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), form = $('daily-note-form');
  const drafts = new Map();
  let day = document.body.dataset.today, baseline = '', note = null, loaded = false, loading = false, pending = false, requestId = 0;
  const isDirty = () => loaded && form.elements.content.value !== baseline;
  const titleFormat = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '날짜와 입력 내용을 확인해주세요.');
    return data;
  }
  function controls() {
    form.querySelector('[type=submit]').disabled = !loaded || loading || pending;
    form.querySelector('[type=submit]').textContent = pending ? '저장 중…' : '메모 저장';
    form.elements.content.disabled = !loaded || loading || pending;
    ['daily-note-date', 'daily-note-prev', 'daily-note-next', 'daily-note-today'].forEach(id => { $(id).disabled = pending; });
    $('daily-note-retry').disabled = loading || pending;
    $('daily-note-draft').textContent = isDirty() ? '아직 저장하지 않은 변경이 있습니다.' : '날짜를 바꿔도 초안은 현재 페이지 안에서 유지됩니다.';
  }
  function keepDraft() {
    if (!loaded) return;
    if (isDirty()) drafts.set(day, form.elements.content.value); else drafts.delete(day);
  }
  function showError(message) { $('daily-note-error').textContent = message; $('daily-note-error').hidden = false; }
  function metadata() {
    $('daily-note-meta').textContent = note ? `저장된 메모${note.content === '' ? ' · 내용 없음' : ''} · 마지막 저장 ${(note.updated_at || '').replace('T', ' ').slice(0, 19)}` : '아직 이 날짜에 저장한 메모가 없습니다.';
  }
  async function loadDay(nextDay = day) {
    if (pending) return;
    keepDraft(); day = nextDay; const token = ++requestId;
    $('daily-note-date').value = day; $('daily-notes-view').dataset.date = day;
    $('daily-note-title').textContent = titleFormat.format(new Date(day + 'T12:00:00'));
    loaded = false; loading = true; form.elements.content.value = ''; controls();
    $('daily-note-error').hidden = true; $('daily-note-status').hidden = true; $('daily-note-meta').textContent = '메모를 불러오는 중…';
    try {
      const result = await api(`/daily-notes/${day}`);
      if (token !== requestId) return;
      note = result; baseline = result?.content ?? '';
      form.elements.content.value = drafts.has(day) ? drafts.get(day) : baseline;
      loaded = true; metadata();
    } catch (error) {
      if (token === requestId) { showError(error.message); $('daily-note-meta').textContent = '읽기에 실패했습니다. 다시 읽은 뒤 저장해주세요.'; }
    } finally { if (token === requestId) { loading = false; controls(); } }
  }
  $('daily-note-date').addEventListener('change', () => {
    const value = $('daily-note-date').value;
    if (!value) { $('daily-note-date').value = day; showError('올바른 날짜를 선택해주세요.'); return; }
    loadDay(value);
  });
  function moveDay(offset) {
    const date = new Date(day + 'T12:00:00'); date.setDate(date.getDate() + offset);
    const target = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
    loadDay(target);
  }
  $('daily-note-prev').addEventListener('click', () => moveDay(-1));
  $('daily-note-next').addEventListener('click', () => moveDay(1));
  $('daily-note-today').addEventListener('click', () => loadDay(document.body.dataset.today));
  $('daily-note-retry').addEventListener('click', () => loadDay());
  form.elements.content.addEventListener('input', () => { keepDraft(); $('daily-note-status').hidden = true; controls(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!loaded || loading || pending) return;
    // 빈 문자열도 의도한 수정이므로 trim하거나 저장을 막지 않는다.
    const content = form.elements.content.value, targetDay = day;
    pending = true; $('daily-note-error').hidden = true; $('daily-note-status').hidden = true; controls();
    try {
      const saved = await api(`/daily-notes/${targetDay}`, { method: 'PUT', body: JSON.stringify({ content }) });
      if (day !== targetDay) return;
      note = saved; baseline = saved.content; form.elements.content.value = saved.content; drafts.delete(targetDay); metadata();
      $('daily-note-status').textContent = content === '' ? '빈 메모로 저장했습니다.' : '메모를 저장했습니다.'; $('daily-note-status').hidden = false;
    } catch (error) { if (day === targetDay) showError(`저장하지 못했습니다. ${error.message}`); }
    finally { pending = false; controls(); }
  });
  document.addEventListener('aleph:data', event => { if (event.detail.view === 'notes' && !loaded && !loading && !pending) loadDay(); });
})();
