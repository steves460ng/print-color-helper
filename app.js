
/* 순수 계산 함수 (화면과 분리) */
var ColorCalc = (function(){
  "use strict";
  var EPS = 216 / 24389;
  var KAP = 24389 / 27;
  var WHITE_D50 = [0.96422, 1.0, 0.82521];

  function clamp(v, min, max){ return v < min ? min : (v > max ? max : v); }

  // Lab(D50) → XYZ(D50)
  function labToXyzD50(L, a, b){
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    var fx3 = fx * fx * fx, fz3 = fz * fz * fz;
    var xr = fx3 > EPS ? fx3 : (116 * fx - 16) / KAP;
    var yr = L > KAP * EPS ? fy * fy * fy : L / KAP;
    var zr = fz3 > EPS ? fz3 : (116 * fz - 16) / KAP;
    return [xr * WHITE_D50[0], yr * WHITE_D50[1], zr * WHITE_D50[2]];
  }

  // Bradford 순응 D50 → D65
  function d50ToD65(x){
    return [
       0.9555766 * x[0] - 0.0230393 * x[1] + 0.0631636 * x[2],
      -0.0282895 * x[0] + 1.0099416 * x[1] + 0.0210077 * x[2],
       0.0122982 * x[0] - 0.0204830 * x[1] + 1.3299098 * x[2]
    ];
  }

  // XYZ(D65) → sRGB (감마 적용, 0~1)
  function xyzToSrgb(x){
    var lin = [
       3.2404542 * x[0] - 1.5371385 * x[1] - 0.4985314 * x[2],
      -0.9692660 * x[0] + 1.8760108 * x[1] + 0.0415560 * x[2],
       0.0556434 * x[0] - 0.2040259 * x[1] + 1.0572252 * x[2]
    ];
    // 입력 반올림과 순응 오차에서 오는 미세한 초과는 색역 경고에서 제외
    var outside = lin.some(function(v){ return v < -0.002 || v > 1.002; });
    var rgb = lin.map(function(v){
      v = clamp(v, 0, 1);
      return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    });
    return { rgb: rgb, outside: outside };
  }

  // sRGB → CMYK (첨부 lab2cmyk의 단순 공식, 0~1)
  function rgbToCmyk(r, g, b){
    var k = 1 - Math.max(r, g, b);
    if (k >= 1 - 1e-12) return [0, 0, 0, 1];
    return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k].map(function(v){
      return clamp(v, 0, 1);
    });
  }

  function toHex(rgb){
    return "#" + rgb.map(function(v){
      return Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
    }).join("");
  }

  // Lab(D50) → 화면색과 CMYK(%)
  function labToColor(L, a, b){
    var s = xyzToSrgb(d50ToD65(labToXyzD50(L, a, b)));
    var cmyk = rgbToCmyk(s.rgb[0], s.rgb[1], s.rgb[2]).map(function(v){ return v * 100; });
    return { hex: toHex(s.rgb), outside: s.outside, cmyk: cmyk };
  }

  function deltaE76(ref, meas){
    var dL = meas[0] - ref[0], da = meas[1] - ref[1], db = meas[2] - ref[2];
    return { dE: Math.sqrt(dL * dL + da * da + db * db), dL: dL, da: da, db: db };
  }

  // 채널 차이(%p) = 측정 − 기준
  function cmykDiff(refCmyk, measCmyk){
    return measCmyk.map(function(v, i){ return v - refCmyk[i]; });
  }

  // 권장값 = 소스 + (기준 − 측정), 0~100 제한
  function adjust(source, diff){
    var raw = source - diff;
    var val = clamp(raw, 0, 100);
    return { raw: raw, value: val, clamped: raw < 0 || raw > 100 };
  }

  return {
    labToXyzD50: labToXyzD50, d50ToD65: d50ToD65, xyzToSrgb: xyzToSrgb,
    rgbToCmyk: rgbToCmyk, toHex: toHex, labToColor: labToColor,
    deltaE76: deltaE76, cmykDiff: cmykDiff, adjust: adjust, clamp: clamp
  };
})();


// All records stay local. Exports are explicit backups; no measurements leave the browser.
const STORAGE_KEY = 'chroma.workspace.v1';
const META_KEYS = ['job', 'sample', 'paper', 'press', 'device', 'mode', 'light', 'method'];
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const now = () => new Date().toISOString();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const f = (v, n = 2) => Number.isFinite(v) ? (Math.abs(v) < .5 * 10 ** -n ? 0 : v).toFixed(n) : '—';
const normalize = value => String(value).trim().replace(/[−‒–—－﹣]/g, '-').replace(/,/g, '.');
const dateLabel = value => new Date(value).toLocaleString('ko-KR');
function emptyStage(index, baselineId = null, threshold = 2) {
  return {id: uid(), name: index === 0 ? '초기 측정' : `${index}차 교정`, baselineId, threshold, rows: [], note: '', createdAt: now()};
}
function emptyProject() {
  const stage = emptyStage(0);
  return {schemaVersion: 1, id: uid(), metadata: Object.fromEntries(META_KEYS.map(k => [k, ''])), target: [], baselines: [], activeBaselineId: null, stages: [stage], selectedStageId: stage.id, updatedAt: now()};
}
function validRows(rows) {
  return Array.isArray(rows) && rows.length <= 10000 && rows.every(r => r && typeof r.id === 'string' && r.id.length < 100 && ['L','a','b'].every(k => Number.isFinite(r[k])) && r.L >= 0 && r.L <= 100 && Math.abs(r.a) <= 1000 && Math.abs(r.b) <= 1000 && typeof r.position === 'string' && r.position.length <= 200 && typeof r.time === 'string' && Number.isFinite(Date.parse(r.time))) && new Set(rows.map(r => r.id)).size === rows.length;
}
function validState(s) {
  if (!s || s.schemaVersion !== 1 || typeof s.id !== 'string' || !s.metadata || !META_KEYS.every(k => typeof s.metadata[k] === 'string' && s.metadata[k].length <= 1000) || !validRows(s.target) || !Array.isArray(s.baselines) || s.baselines.length > 1000 || !Array.isArray(s.stages) || !s.stages.length || s.stages.length > 1000) return false;
  const baselineIds = new Set(s.baselines.map(b => b.id));
  if (baselineIds.size !== s.baselines.length || !s.baselines.every(b => typeof b.id === 'string' && Number.isInteger(b.version) && b.version > 0 && validRows(b.rows) && b.rows.length > 0 && Number.isFinite(Date.parse(b.createdAt)))) return false;
  if (s.activeBaselineId !== null && !baselineIds.has(s.activeBaselineId)) return false;
  if (new Set(s.stages.map(t => t.id)).size !== s.stages.length) return false;
  return s.stages.every(t => typeof t.id === 'string' && typeof t.name === 'string' && t.name.length <= 100 && typeof t.note === 'string' && t.note.length <= 2000 && validRows(t.rows) && Number.isFinite(t.threshold) && t.threshold >= 0 && t.threshold <= 100 && (t.baselineId === null ? t.rows.length === 0 : baselineIds.has(t.baselineId)) && Number.isFinite(Date.parse(t.createdAt))) && s.stages.some(t => t.id === s.selectedStageId);
}
let state = emptyProject();
let storageFailure = false;
let loadError = '';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    if (!validState(parsed)) throw new Error('저장 데이터의 형식이 올바르지 않습니다.');
    state = parsed;
  }
} catch (e) {
  storageFailure = true;
  loadError = '저장 기록을 읽을 수 없습니다. 기존 저장값은 덮어쓰지 않습니다. JSON 백업을 가져오거나 새 작업을 시작하세요.';
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').style.display = 'block';
  toastTimer = setTimeout(() => $('toast').style.display = 'none', 6000);
}
function save() {
  state.updatedAt = now();
  if (loadError) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageFailure = false;
    $('save-status').textContent = '이 브라우저에 저장됨';
    $('storage-note').textContent = '기록은 이 브라우저에 저장됩니다. JSON 파일로 정기 백업하세요.';
  } catch (e) {
    storageFailure = true;
    $('save-status').textContent = '저장 실패 · JSON 백업 필요';
    $('storage-note').textContent = '자동 저장이 불가능합니다. 창을 닫기 전에 JSON으로 기록을 내보내세요.';
    toast('자동 저장에 실패했습니다. JSON 저장으로 백업하세요.');
  }
}
const current = () => state.stages.find(s => s.id === state.selectedStageId);
const baselineFor = stage => state.baselines.find(b => b.id === stage.baselineId);
const activeBaseline = () => state.baselines.find(b => b.id === state.activeBaselineId);
const vector = row => [row.L, row.a, row.b];
const de = (a, b) => ColorCalc.deltaE76(a, b).dE;
function stats(rows) {
  const n = rows.length;
  const mean = [0,1,2].map(i => n ? rows.reduce((sum,r) => sum + vector(r)[i], 0) / n : NaN);
  const variance = mean.map((m,i) => n > 1 ? rows.reduce((sum,r) => sum + (vector(r)[i] - m) ** 2, 0) / (n-1) : NaN);
  const min = [0,1,2].map(i => n ? Math.min(...rows.map(r => vector(r)[i])) : NaN);
  const max = [0,1,2].map(i => n ? Math.max(...rows.map(r => vector(r)[i])) : NaN);
  const distances = rows.map(r => de(vector(r), mean));
  return {n, mean, variance, sd: variance.map(Math.sqrt), min, max, distances};
}
function distanceStats(rows, targetMean) {
  const values = rows.map(r => de(vector(r), targetMean));
  return {avg: values.length ? values.reduce((a,b) => a+b,0) / values.length : NaN, max: values.length ? Math.max(...values) : NaN};
}
function readMeasurement(prefix) {
  const values = ['L','a','b'].map(k => normalize($(prefix+k).value));
  const valid = values.every(v => /^[-+]?(\d+\.?\d*|\.\d+)$/.test(v) && Number.isFinite(Number(v)));
  if (!valid) { toast('L*, a*, b*에 유효한 숫자를 모두 입력하세요.'); return null; }
  const [L,a,b] = values.map(Number);
  if (L < 0 || L > 100) { toast('L*는 0~100 범위로 입력하세요.'); return null; }
  // Guard arithmetic from malformed extremes, not a definition of CIELab's gamut.
  if (Math.abs(a) > 1000 || Math.abs(b) > 1000) { toast('a*, b* 값이 비정상적으로 큽니다. 장비 측정값을 확인하세요.'); return null; }
  return {id: uid(), L, a, b, position: $(prefix+'pos').value, time: now()};
}
function changed() { save(); render(); }
function add(which) {
  if (which === 'print' && !baselineFor(current())) return toast('먼저 타겟 측정값을 추가하고 타겟 기준을 확정하세요.');
  const row = readMeasurement(which === 'target' ? 't' : 'p');
  if (!row) return;
  const rows = which === 'target' ? state.target : current().rows;
  if (rows.length >= 10000) return toast('한 측정 묶음에는 최대 10,000개를 기록할 수 있습니다.');
  if (which === 'print' && !rows.length) current().metadata = structuredClone(state.metadata);
  rows.push(row);
  changed();
  toast('측정값을 기록했습니다.');
}
function remove(which, id) {
  const rows = which === 'target' ? state.target : current().rows;
  const index = rows.findIndex(r => r.id === id);
  if (index < 0) return;
  if (!confirm('이 측정 기록을 삭제할까요?')) return;
  rows.splice(index, 1);
  changed();
}
function editMeasurement(which,id) {
  const rows=which==='target'?state.target:current().rows;
  const row=rows.find(r=>r.id===id);
  if(!row)return;
  const values=[];
  for(const [key,label] of [['L','L*'],['a','a*'],['b','b*']]) {
    const answer=prompt(label+' 측정값을 수정하세요.',row[key]);
    if(answer===null)return;
    const text=normalize(answer),value=Number(text);
    if(!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)||!Number.isFinite(value)||(key==='L'?(value<0||value>100):Math.abs(value)>1000))return toast('유효한 측정값을 입력하세요.');
    values.push(value);
  }
  const position=prompt('측정 위치',row.position);
  if(position===null)return;
  if(position.length>200)return toast('위치는 200자 이하로 입력하세요.');
  Object.assign(row,{L:values[0],a:values[1],b:values[2],position,editedAt:now()});
  changed();
}
function clearTarget() {
  if(!confirm('타겟 초안의 측정값을 비울까요? 이미 확정한 기준과 이전 교정 결과는 유지됩니다.'))return;
  state.target=[]; changed();
}
function toggleDetail(which) {
  const collapsed = $(which+'-detail').classList.toggle('hidden');
  $(which+'-detail-button').setAttribute('aria-expanded', String(!collapsed));
  $(which+'-detail-button').textContent = collapsed ? '＋ 상세 통계 펼치기' : '− 상세 통계 접기';
}
function targetChanged() {
  const baseline = activeBaseline();
  return !baseline || JSON.stringify(state.target) !== JSON.stringify(baseline.rows);
}
function confirmBaseline() {
  if (!state.target.length) return toast('타겟 측정값을 먼저 추가하세요.');
  if (!targetChanged()) return toast('현재 타겟 측정값은 이미 기준으로 확정되어 있습니다.');
  if (state.baselines.length >= 1000) return toast('기준 버전이 너무 많습니다. 백업 후 새 작업을 시작하세요.');
  const baseline = {id: uid(), version: state.baselines.length + 1, rows: structuredClone(state.target), createdAt: now(), metadata: structuredClone(state.metadata)};
  state.baselines.push(baseline);
  state.activeBaselineId = baseline.id;
  if (current().rows.length) {
    if (state.stages.length >= 1000) { state.baselines.pop(); state.activeBaselineId = state.baselines.at(-1)?.id ?? null; return toast('교정 단계가 너무 많습니다. 백업 후 새 작업을 시작하세요.'); }
    const stage = emptyStage(state.stages.length, baseline.id, current().threshold);
    stage.note = '타겟 기준 변경';
    state.stages.push(stage);
    state.selectedStageId = stage.id;
  } else current().baselineId = baseline.id;
  changed();
  toast(`타겟 기준 ${baseline.version}을 확정했습니다. 기존 교정 결과의 기준은 유지됩니다.`);
}
function nextStage() {
  const baseline = activeBaseline();
  if (!baseline) return toast('타겟 기준을 먼저 확정하세요.');
  if (targetChanged()) return toast('타겟 측정값이 변경되었습니다. 기준을 확정한 뒤 다음 교정을 시작하세요.');
  if (!current().rows.length) return toast('현재 단계에 인쇄물 측정값을 먼저 기록하세요.');
  if (state.stages.length >= 1000) return toast('교정 단계가 너무 많습니다. 백업 후 새 작업을 시작하세요.');
  const stage = emptyStage(state.stages.length, baseline.id, current().threshold);
  state.stages.push(stage);
  state.selectedStageId = stage.id;
  changed();
  toast('새 교정 단계를 시작했습니다. 실제 조정 내용도 기록하세요.');
}
function selectStage(id) {
  if (!state.stages.some(s => s.id === id)) return;
  state.selectedStageId = id;
  for (const k of ['L','a','b']) $('p'+k).value = '';
  changed();
}
function updateNote() { current().note = $('stage-note').value.slice(0,2000); save(); renderHistory(); }
function updateThreshold() {
  const raw = normalize($('threshold').value);
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 0 || n > 100) { $('threshold').value = current().threshold; return toast('허용치는 0~100 사이 숫자로 입력하세요.'); }
  current().threshold = n;
  changed();
}
function syncMeta() {
  for (const key of META_KEYS) {
    state.metadata[key] = $('meta-'+key).value.slice(0,1000);
    $('print-'+key).textContent = state.metadata[key].trim() || '미입력';
  }
  save();
}
function hydrate() {
  for (const key of META_KEYS) {
    $('meta-'+key).value = state.metadata[key];
    $('print-'+key).textContent = state.metadata[key].trim() || '미입력';
  }
  for (const prefix of ['t','p']) for (const k of ['L','a','b']) $(prefix+k).value = '';
  render();
}
function statsTable(data) {
  const rows = [
    ['측정 횟수', [data.n+'회',data.n+'회',data.n+'회']],
    ['평균', data.mean.map(v => f(v))],
    ['표본 분산', data.variance.map(v => f(v,4))],
    ['표본 표준편차', data.sd.map(v => f(v,3))],
    ['최솟값', data.min.map(v => f(v))],
    ['최댓값', data.max.map(v => f(v))]
  ];
  return '<table class="detail-table"><caption>측정값 상세 통계</caption><thead><tr><th scope="col">항목</th><th scope="col">L*</th><th scope="col">a*</th><th scope="col">b*</th></tr></thead><tbody>' + rows.map(([label,values]) => `<tr><th scope="row">${label}</th>${values.map(v => `<td>${v}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}
function spreadSummary(data) {
  const avg = data.n ? data.distances.reduce((a,b) => a+b,0)/data.n : NaN;
  const max = data.n ? Math.max(...data.distances) : NaN;
  return `<div class="spread-summary">각 측정값 ↔ 해당 평균색 ΔE76 · 평균 <strong>${f(avg,3)}</strong> / 최대 <strong>${f(max,3)}</strong></div><p class="stats-note">±는 표본 표준편차이며 평균의 신뢰구간이나 허용 오차가 아닙니다. 표본 분산은 n−1로 계산하고, 측정 2개 미만이면 분산·표준편차를 표시하지 않습니다. 다른 위치를 측정하면 시료의 불균일성도 포함됩니다.</p>`;
}
function renderMeasurements(which, rows) {
  const data = stats(rows);
  $(which+'-table').innerHTML = rows.length ? rows.map((r,i) => `<tr><td>${i+1}</td><td title="${escapeHtml(dateLabel(r.time))}">${escapeHtml(r.position)}</td><td>${f(r.L)}</td><td>${f(r.a)}</td><td>${f(r.b)}</td><td class="no-print"><button class="edit-row" data-which="${which}" data-id="${escapeHtml(r.id)}" aria-label="${i+1}번 측정 수정">수정</button><button class="del" data-which="${which}" data-id="${escapeHtml(r.id)}" aria-label="${i+1}번 측정 삭제">×</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty-row">아직 기록된 측정값이 없습니다.</td></tr>';
  $(which+'-stats').innerHTML = data.mean.map((v,i) => `<div class="stat"><span>평균 ${['L*','a*','b*'][i]}</span><strong>${f(v)}</strong><small>표준편차 ± ${f(data.sd[i])}</small></div>`).join('');
  $(which+'-detail').innerHTML = statsTable(data) + spreadSummary(data);
}
function direction(value, positive, negative) { return Math.abs(value) < .005 ? '차이 작음' : (value > 0 ? positive : negative); }
function renderComparison() {
  const stage = current(), baseline = baselineFor(stage);
  const target = stats(baseline ? baseline.rows : []), measured = stats(stage.rows);
  const valid = target.n && measured.n;
  const delta = valid ? de(target.mean, measured.mean) : NaN;
  $('de').textContent = f(delta);
  $('verdict').textContent = valid ? delta <= stage.threshold ? '● 합격' : '● 불합격' : '측정 대기';
  $('verdict').style.color = valid && delta > stage.threshold ? '#a96827' : '#275f45';
  $('threshold-print').textContent = `허용치 ΔE76 ≤ ${stage.threshold}`;
  $('count-copy').textContent = `${baseline ? '기준 '+baseline.version : '기준 미확정'} · 타겟 ${target.n}회 평균 ↔ 인쇄물 ${measured.n}회 평균 · ${stage.name}`;
  if (!valid) {
    $('channels').textContent = '타겟 기준을 확정하고 인쇄물 측정값을 추가하세요.';
    $('guide-copy').textContent = '측정값 입력 대기';
    $('sw-target').style.background = '#eee';
    $('sw-print').style.background = '#eee';
    return;
  }
  const ca = ColorCalc.labToColor(...target.mean), cb = ColorCalc.labToColor(...measured.mean);
  const outside = ca.outside || cb.outside;
  $('sw-target').style.background = ca.hex;
  $('sw-print').style.background = cb.hex;
  $('channels').innerHTML = ca.cmyk.map((v,i) => {
    const diff = cb.cmyk[i]-v, ch = 'cmyk'[i];
    const move = outside ? '색역 밖 · 안내 보류' : Math.abs(diff)<.1 ? '차이 작음' : diff>0 ? '↓ 감소 참고' : '↑ 증가 참고';
    return `<div class="chrow"><span class="ch ${ch}">${ch.toUpperCase()}</span><div class="tracks ${ch}"><div class="track"><div class="fill target" style="width:${v}%"></div></div><div class="track"><div class="fill" style="width:${cb.cmyk[i]}%"></div></div><div class="barvalues">타겟 ${f(v,1)}% · 인쇄물 ${f(cb.cmyk[i],1)}%${outside?' · 색역 잘림':''}</div></div><div class="movement">${Math.abs(diff)>=.05 && diff>0?'+':''}${f(diff,1)}%p<small>${move}</small></div></div>`;
  }).join('');
  const diff = measured.mean.map((v,i) => v-target.mean[i]);
  const inc = ca.cmyk.map((v,i) => v-cb.cmyk[i]>=.1?'CMYK'[i]:null).filter(Boolean);
  const dec = ca.cmyk.map((v,i) => v-cb.cmyk[i]<=-.1?'CMYK'[i]:null).filter(Boolean);
  const guide = outside ? 'sRGB 색역 밖 · CMYK 방향 안내 보류' : [inc.length ? inc.join('·')+' 증가 쪽' : '',dec.length ? dec.join('·')+' 감소 쪽' : ''].filter(Boolean).join(' / ') || '환산상 채널 차이가 작습니다';
  const spread = distanceStats(stage.rows,target.mean);
  $('guide-copy').innerHTML = `<div class="guideitem"><span class="arrow">↗</span><div><strong>측정된 색의 편차</strong><p>ΔL* ${f(diff[0])} · Δa* ${f(diff[1])} · Δb* ${f(diff[2])}<br>${direction(diff[0],'밝은 방향','어두운 방향')} / ${direction(diff[1],'적색 방향','녹색 방향')} / ${direction(diff[2],'황색 방향','청색 방향')}</p></div></div><div class="guideitem"><span class="arrow">⇄</span><div><strong>${guide}</strong><p>${outside?'환산 과정에서 색이 잘려 CMYK 수치로 보정 방향을 판단하기 어렵습니다.':delta<=stage.threshold?'현재 평균색은 허용치 이내입니다. 추가 조정 필요성을 먼저 확인하세요.':'환산상 참고 방향입니다. 소량 시험 조정 후 색차가 줄었는지 확인하세요.'}</p></div></div><p class="stats-note">개별 측정 ↔ 타겟 평균 ΔE76 · 평균 ${f(spread.avg)} / 최대 ${f(spread.max)}<br>평균색 판정과 개별 색차는 다를 수 있습니다. 측정 흔들림과 비슷한 작은 편차는 재측정하여 확인하세요.</p>`;
}
function renderHistory() {
  $('history').innerHTML = state.stages.map(stage => {
    const measured = stats(stage.rows), baseline = baselineFor(stage);
    const delta = baseline && measured.n ? de(stats(baseline.rows).mean,measured.mean) : NaN;
    return `<tr class="${stage.id===state.selectedStageId?'current':''}"><td>${escapeHtml(stage.name)}${stage.id===state.selectedStageId?' · 선택':''}<br><span class="mini">${baseline?'기준 '+baseline.version:'기준 미확정'} · 허용치 ${stage.threshold}</span></td><td>${measured.n}회</td><td>${measured.mean.map(v=>f(v)).join(' / ')}</td><td>${f(delta)}</td><td>${Number.isFinite(delta)?delta<=stage.threshold?'합격':'불합격':'대기'}</td><td>${escapeHtml(stage.note||'미입력')}</td></tr>`;
  }).join('');
}
function render() {
  const stage = current(), baseline = activeBaseline();
  renderMeasurements('target',state.target);
  renderMeasurements('print',stage.rows);
  $('baseline-status').textContent = baseline ? `기준 ${baseline.version} · ${targetChanged()?'초안 변경됨':'확정'}` : '타겟 미확정';
  $('baseline-hint').textContent = targetChanged() && baseline ? '추가·삭제된 초안은 기준 확정 전까지 판정에 반영되지 않습니다.' : '확정한 기준은 교정 단계별로 보존됩니다.';
  const usedBaseline = baselineFor(stage);
  $('target-context').textContent = usedBaseline ? `현재 판정 기준 ${usedBaseline.version}: Lab ${stats(usedBaseline.rows).mean.map(v=>f(v)).join(' / ')}. 아래 표는 수정 가능한 타겟 초안입니다.` : '아래 측정값은 타겟 초안입니다. 기준 확정 후 인쇄물을 비교할 수 있습니다.';
  $('stage-pill').textContent = stage.name;
  $('stage-note').value = stage.note;
  $('threshold').value = stage.threshold;
  $('stage-select').innerHTML = state.stages.map(s => `<option value="${escapeHtml(s.id)}" ${s.id===stage.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  renderComparison();
  renderHistory();
}
function download(text, type, name) {
  const url = URL.createObjectURL(new Blob([text],{type}));
  const link = document.createElement('a');
  link.href=url; link.download=name; link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportData() { download(JSON.stringify(state,null,2),'application/json',`chroma-${new Date().toISOString().slice(0,10)}.json`); }
function exportCsv() {
  const rows=[];
  rows[0]=['구분','기준/단계','번호','측정 시각','위치','L*','a*','b*','허용치 ΔE76','조정 메모'];
  const addRows=(kind,name,data,threshold='',note='')=>data.forEach((r,i)=>rows.push([kind,name,i+1,r.time,r.position,r.L,r.a,r.b,threshold,note]));
  addRows('타겟 초안','초안',state.target);
  state.baselines.forEach(b=>addRows('타겟 기준',b.version,b.rows));
  state.stages.forEach(s=>addRows('인쇄물',`${s.name} / 기준 ${baselineFor(s)?.version??'미확정'}`,s.rows,s.threshold,s.note));
  const cell=v=>{let t=String(v);if(/^[=+@\-\t\r]/.test(t)&&typeof v!=='number')t="'"+t;return '"'+t.replace(/"/g,'""')+'"';};
  download('\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8',`chroma-${new Date().toISOString().slice(0,10)}.csv`);
}
async function importData(input) {
  const file=input.files[0];
  if (!file) return;
  try {
    if(file.size>10*1024*1024)throw new Error('파일은 10MB 이하만 가져올 수 있습니다.');
    const parsed=JSON.parse(await file.text());
    if(!validState(parsed))throw new Error('지원하는 CHROMA 기록 형식이 아닙니다.');
    if(!confirm('현재 작업을 가져온 기록으로 교체할까요? 필요한 경우 먼저 JSON으로 백업하세요.'))return;
    state=parsed; loadError=''; hydrate(); save(); toast('기록을 복원했습니다.');
  }catch(e){toast('가져오기 실패: '+e.message);}finally{input.value='';}
}
function newProject() {
  if(!confirm('새 작업을 시작할까요? 현재 기록은 교체됩니다. 필요한 경우 먼저 JSON으로 백업하세요.'))return;
  state=emptyProject(); loadError=''; hydrate(); save(); toast('새 작업을 시작했습니다.');
}
function rawTable(rows) {
  return '<table><thead><tr><th>번호</th><th>측정 시각</th><th>위치</th><th>L*</th><th>a*</th><th>b*</th></tr></thead><tbody>'+rows.map((r,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(dateLabel(r.time))}</td><td>${escapeHtml(r.position)}</td><td>${f(r.L)}</td><td>${f(r.a)}</td><td>${f(r.b)}</td></tr>`).join('')+'</tbody></table>';
}
function buildReport() {
  $('report-time').textContent = '생성 시각 '+dateLabel(now());
  const targets=state.baselines.map(b=>`<div class="report-block"><h2>타겟 기준 ${b.version}</h2><p>확정 시각 ${escapeHtml(dateLabel(b.createdAt))}</p>${b.metadata?'<p>확정 당시 측정 조건: '+['device','mode','light','method'].map(k=>escapeHtml(b.metadata[k]||'미입력')).join(' / ')+'</p>':''}${statsTable(stats(b.rows))}${spreadSummary(stats(b.rows))}<h3>타겟 원본 측정 기록</h3>${rawTable(b.rows)}</div>`).join('');
  const stages=state.stages.map(s=>{
    const baseline=baselineFor(s),data=stats(s.rows),target=baseline?stats(baseline.rows):null;
    const delta=target&&data.n?de(target.mean,data.mean):NaN,dist=target?distanceStats(s.rows,target.mean):{avg:NaN,max:NaN};
    return `<div class="report-block"><h2>${escapeHtml(s.name)} · 전체 측정 기록</h2><p>${baseline?'타겟 기준 '+baseline.version:'기준 미확정'} · 허용치 ${s.threshold} · 평균색 ΔE76 ${f(delta)} · ${Number.isFinite(delta)?delta<=s.threshold?'합격':'불합격':'측정 대기'}</p><p>개별 측정 ↔ 타겟 평균 ΔE76 · 평균 ${f(dist.avg)} / 최대 ${f(dist.max)}</p><p>실제 조정 내용: ${escapeHtml(s.note||'미입력')}</p>${s.metadata?'<p>측정 당시 조건: '+['device','mode','light','method'].map(k=>escapeHtml(s.metadata[k]||'미입력')).join(' / ')+'</p>':''}${statsTable(data)}${spreadSummary(data)}${rawTable(s.rows)}</div>`;
  }).join('');
  $('report-archive').innerHTML=targets+stages;
}
function printReport() {
  if(!state.metadata.mode||!state.metadata.light)toast('보고서에 측정 조건이 미입력 상태로 표시됩니다.');
  buildReport(); window.print();
}
window.addEventListener('beforeprint',buildReport);
window.addEventListener('beforeunload',e=>{if(storageFailure){e.preventDefault();e.returnValue='';}});
// Avoid silently replacing another tab's changes.
window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY){loadError='다른 탭에서 기록이 변경되었습니다.';storageFailure=true;$('save-status').textContent='다른 탭 변경 · 저장 중지';toast('다른 탭에서 기록이 변경되었습니다. 현재 내용을 JSON으로 백업한 뒤 새로고침하세요.');}});
document.addEventListener('click',e=>{const button=e.target.closest('button.del');if(button)remove(button.dataset.which,button.dataset.id);const edit=e.target.closest('button.edit-row');if(edit)editMeasurement(edit.dataset.which,edit.dataset.id);});
hydrate();
if(loadError){$('save-status').textContent='저장 기록 확인 필요';$('storage-note').textContent=loadError;toast(loadError);}else save();
