import { getDehlerBoatSpeed } from './polar.js';

export function drawPolarDiagramCanvas(selectedTws) {
  const canvas = document.getElementById('polarCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const maxSpeed = 10.0;
  const radius = w * 0.44;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  for (let s = 2; s <= maxSpeed; s += 2) {
    const r = (s / maxSpeed) * radius;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '9px monospace';
    ctx.fillText(`${s}k`, cx + 3, cy - r + 9);
  }

  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;

  for (let angle = 0; angle <= 180; angle += 2) {
    const spd = getDehlerBoatSpeed(angle, selectedTws);
    const r = (spd / maxSpeed) * radius;
    const rad = (angle - 90) * Math.PI / 180;
    const px = cx + r * Math.cos(rad);
    const py = cy + r * Math.sin(rad);
    if (angle === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }

  for (let angle = 180; angle >= 0; angle -= 2) {
    const spd = getDehlerBoatSpeed(angle, selectedTws);
    const r = (spd / maxSpeed) * radius;
    const rad = (-angle - 90) * Math.PI / 180;
    const px = cx + r * Math.cos(rad);
    const py = cy + r * Math.sin(rad);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
  ctx.fill();
  ctx.stroke();

  let maxUpwindVmg = 0, optUpwindTwa = 42;
  let maxDownwindVmg = 0, optDownwindTwa = 145;

  for (let a = 34; a <= 70; a++) {
    const spd = getDehlerBoatSpeed(a, selectedTws);
    const vmg = spd * Math.cos(a * Math.PI / 180);
    if (vmg > maxUpwindVmg) {
      maxUpwindVmg = vmg;
      optUpwindTwa = a;
    }
  }

  for (let a = 120; a <= 170; a++) {
    const spd = getDehlerBoatSpeed(a, selectedTws);
    const vmg = spd * -Math.cos(a * Math.PI / 180);
    if (vmg > maxDownwindVmg) {
      maxDownwindVmg = vmg;
      optDownwindTwa = a;
    }
  }

  document.getElementById('upwindVmgVal').textContent = `${maxUpwindVmg.toFixed(1)} kn @ ${optUpwindTwa}°`;
  document.getElementById('downwindVmgVal').textContent = `${maxDownwindVmg.toFixed(1)} kn @ ${optDownwindTwa}°`;
}
