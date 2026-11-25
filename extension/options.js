const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

$('ver').textContent = chrome.runtime.getManifest().version;
$('bypass').placeholder = 'example.com\n*.example.org\n192.168.1.0/24';

function showPaired(paired) {
  $('pairtext').textContent = paired
    ? 'This browser is paired with the Tangent app. Forgetting it also turns Tangent off in this browser.'
    : 'This browser is not paired with the Tangent app. Connect from the Tangent button in the toolbar.';
  $('forget').hidden = !paired;
}

let savedTimer = null;
function flash(text) {
  const s = $('saved');
  s.textContent = text;
  s.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove('show'), 2200);
}

async function load() {
  const st = await send('settings');
  if (!st) return;
  $('bypass').value = (st.bypass || []).join('\n');
  $('stopapp').checked = !!st.alsoStopApp;
  showPaired(st.paired);
  $('page').classList.add('ready');
}

$('save').addEventListener('click', async () => {
  const r = await send('saveBypass', { text: $('bypass').value });
  const box = $('errors');
  box.replaceChildren();
  if (!r) return;
  if (!r.ok) {
    for (const e of r.errors) {
      const li = document.createElement('li');
      if (e.line) {
        li.append(`Line ${e.line}, `);
        const c = document.createElement('code');
        c.textContent = e.text;
        li.append(c, ` ${e.message}.`);
      } else {
        li.textContent = `This list ${e.message}.`;
      }
      box.append(li);
    }
    box.hidden = false;
    return;
  }
  box.hidden = true;
  $('bypass').value = r.list.join('\n');
  flash(r.list.length ? 'Saved' : 'Saved, every site goes through Tangent');
});

$('stopapp').addEventListener('change', (e) => send('alsoStopApp', { value: e.target.checked }));

$('forget').addEventListener('click', async () => {
  await send('forget');
  showPaired(false);
});

load();
