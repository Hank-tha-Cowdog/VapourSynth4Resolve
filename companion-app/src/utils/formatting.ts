export const formatTimecode = (frame: number, fps: number, mode: string) => {
  if (!fps || fps === 0) return "00:00:00:00";
  if (mode === 'FRAME') return frame.toString();
  if (mode === 'FIELDS') return (frame * 2).toString();
  const totalSeconds = frame / fps;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const f = Math.floor((totalSeconds % 1) * fps) % Math.floor(fps); 
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
};