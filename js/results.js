export function updateHudDisplay(leg) {
  document.getElementById('hudTws').textContent = leg.tws;
  document.getElementById('hudTwd').textContent = `${leg.twd}°`;
  document.getElementById('hudTwdArrow').style.transform = `rotate(${leg.twd}deg)`;

  document.getElementById('hudCurSpeed').textContent = leg.currentSpeed;
  document.getElementById('hudCurDir').textContent = `${leg.currentDir}°`;
  document.getElementById('hudCurArrow').style.transform = `rotate(${leg.currentDir}deg)`;

  document.getElementById('hudStw').textContent = leg.stw;
  document.getElementById('hudSog').textContent = leg.sog;

  const hudWaveHeight = document.getElementById('hudWaveHeight');
  if (hudWaveHeight) {
    hudWaveHeight.textContent = leg.waveHeight ?? '–';
    document.getElementById('hudWaveDir').textContent = leg.waveDir !== undefined ? `${leg.waveDir}°` : '–';
    document.getElementById('hudWaveArrow').style.transform = `rotate(${leg.waveDir ?? 0}deg)`;
  }
}

function buildLegCard(leg) {
  const legDurHrs = Math.floor(leg.durationHours);
  const legDurMins = Math.round((leg.durationHours - legDurHrs) * 60);

  const card = document.createElement('div');
  card.className = 'bg-marine-900/90 border border-slate-700/80 rounded-xl p-2.5 space-y-1.5';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between border-b border-slate-800 pb-1 text-xs';

  const title = document.createElement('span');
  title.className = 'font-bold text-sky-300 flex items-center';
  title.textContent = `Leg ${leg.index}: Kurs ${leg.cog}° `;

  if (leg.isBeating) {
    const tackBadge = document.createElement('span');
    const isStbd = leg.tackSide.includes('Steuer');
    tackBadge.className = `text-[9px] px-1.5 py-0.5 rounded ${isStbd ? 'bg-sky-500/20 text-sky-300 border border-sky-400/30' : 'bg-amber-500/20 text-amber-300 border border-amber-400/30'} font-bold ml-1`;
    tackBadge.textContent = leg.tackSide;
    title.appendChild(tackBadge);
  }

  const sog = document.createElement('span');
  sog.className = 'font-mono text-emerald-400 font-bold';
  sog.textContent = `${leg.sog} kn SOG`;

  header.append(title, sog);

  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-3 gap-1 text-[10px] text-slate-300';

  const cells = [
    ['Dist: ', `${leg.distance} nm`],
    ['HDG: ', `${leg.heading}°`],
    ['Zeit: ', `${legDurHrs}h ${legDurMins}m`],
    ['Wind: ', `${leg.tws}k @ ${leg.twd}°`, 'text-sky-300'],
    ['TWA: ', `${leg.twa}°`, 'text-sky-300'],
    ['Strom: ', `${leg.currentSpeed}k → ${leg.currentDir}°`, 'text-emerald-300'],
    ['Welle: ', `${leg.waveHeight ?? '–'}m @ ${leg.waveDir ?? '–'}°`, 'text-violet-300'],
    ['Abtrift: ', `${leg.leewayDeg ?? 0}°`, 'text-amber-300']
  ];

  cells.forEach(([label, value, strongClass]) => {
    const cell = document.createElement('div');
    cell.append(document.createTextNode(label));
    const strong = document.createElement('strong');
    strong.className = strongClass || 'text-white';
    strong.textContent = value;
    cell.appendChild(strong);
    grid.appendChild(cell);
  });

  card.append(header, grid);
  return card;
}

export function renderRouteResults(data) {
  document.getElementById('resTotalDist').textContent = `${data.totalDistance} nm`;

  const hrs = Math.floor(data.totalHours);
  const mins = Math.round((data.totalHours - hrs) * 60);
  document.getElementById('resTotalTime').textContent = `${hrs}h ${mins}m`;

  const avgSog = (data.totalDistance / Math.max(0.1, data.totalHours)).toFixed(1);
  document.getElementById('resAvgSog').textContent = `${avgSog} kn`;

  document.getElementById('resEtaTime').textContent = data.arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
    ` (${data.arrivalTime.toLocaleDateString([], { month: 'short', day: 'numeric' })})`;

  const avgStw = (data.legs.reduce((acc, l) => acc + l.stw, 0) / Math.max(1, data.legs.length)).toFixed(1);
  const diff = +(avgSog - avgStw).toFixed(1);
  const effectEl = document.getElementById('resCurrentEffect');
  effectEl.textContent = `${diff >= 0 ? '+' : ''}${diff} kn (${diff >= 0 ? 'Mitstrom' : 'Gegenstrom'})`;
  effectEl.className = diff >= 0 ? 'text-emerald-400 font-mono font-bold' : 'text-rose-400 font-mono font-bold';

  const legContainer = document.getElementById('legTableContainer');
  document.getElementById('legCount').textContent = data.legs.length;
  legContainer.innerHTML = '';
  data.legs.forEach(leg => legContainer.appendChild(buildLegCard(leg)));

  if (data.legs.length > 0) {
    updateHudDisplay(data.legs[0]);
  }
}
