// Toast notifications, sidebar drawer, and tab switching — pure DOM/UI, no app state.

let toastTimer = null;

export function showToast(msg, type = 'sky') {
  const toast = document.getElementById('toastBox');
  const text = document.getElementById('toastMessage');
  text.textContent = msg;
  toast.classList.remove('opacity-0', 'scale-95');
  toast.classList.add('opacity-100', 'scale-100');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('opacity-100', 'scale-100');
    toast.classList.add('opacity-0', 'scale-95');
  }, 2600);
}

export function toggleSidebar(open = null) {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const isOpen = !sidebar.classList.contains('-translate-x-full');
  const shouldOpen = open !== null ? open : !isOpen;

  if (shouldOpen) {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('opacity-0', 'pointer-events-none');
    backdrop.classList.add('opacity-100');
  } else {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('opacity-0', 'pointer-events-none');
    backdrop.classList.remove('opacity-100');
  }
}

const TAB_IDS = ['waypointsTab', 'isochroneTab', 'polarsTab', 'hazardsTab', 'resultsTab'];
const TAB_BUTTON_IDS = {
  waypointsTab: 'tabBtnWaypoints',
  isochroneTab: 'tabBtnIsochrone',
  polarsTab: 'tabBtnPolars',
  hazardsTab: 'tabBtnHazards',
  resultsTab: 'tabBtnResults'
};

export function switchTab(tabId, onPolarsTab) {
  TAB_IDS.forEach(t => {
    const el = document.getElementById(t);
    const btn = document.getElementById(TAB_BUTTON_IDS[t]);
    if (t === tabId) {
      el.classList.remove('hidden');
      el.classList.add('flex');
      btn.classList.add('text-sky-400', 'border-sky-400', 'font-bold');
      btn.classList.remove('text-slate-400', 'border-transparent');
      btn.setAttribute('aria-selected', 'true');
    } else {
      el.classList.add('hidden');
      el.classList.remove('flex');
      btn.classList.remove('text-sky-400', 'border-sky-400', 'font-bold');
      btn.classList.add('text-slate-400', 'border-transparent');
      btn.setAttribute('aria-selected', 'false');
    }
  });

  if (tabId === 'polarsTab' && typeof onPolarsTab === 'function') {
    onPolarsTab();
  }
}
