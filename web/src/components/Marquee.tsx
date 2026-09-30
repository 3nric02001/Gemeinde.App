import { useEffect, useRef, useState } from 'preact/hooks';

/** Pixel pro Sekunde, mit denen der Text durchläuft. */
const SPEED = 40;
/** So lange bleibt der Text an jedem Ende stehen (ms). */
const PAUSE = 2500;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Einzeiliger Text, der langsam hin und zurück läuft, wenn er nicht in die Zeile passt,
 * und an beiden Enden kurz stehen bleibt. Passt er, steht er still.
 * Bei "Bewegung reduzieren" läuft nichts, der Text bricht stattdessen um (siehe styles.css).
 */
export function Marquee({ text }: { text: string }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    const update = () => {
      const overflow = content.scrollWidth - box.clientWidth;
      setShift(overflow > 1 && !reducedMotion() ? Math.ceil(overflow) : 0);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(box);
    return () => observer?.disconnect();
  }, [text]);

  useEffect(() => {
    const content = inner.current;
    if (!shift || !content || typeof content.animate !== 'function') return;
    // Stehen, hinlaufen, stehen, zurücklaufen: die Pausen bleiben unabhängig von der Titellänge gleich lang.
    const travel = (shift / SPEED) * 1000;
    const total = 2 * (PAUSE + travel);
    const at = (ms: number) => ms / total;
    const end = `translateX(-${shift}px)`;
    const animation = content.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: at(PAUSE), easing: 'ease-in-out' },
        { transform: end, offset: at(PAUSE + travel) },
        { transform: end, offset: at(2 * PAUSE + travel), easing: 'ease-in-out' },
        { transform: 'translateX(0)', offset: 1 },
      ],
      { duration: total, iterations: Infinity },
    );
    return () => animation.cancel();
  }, [shift]);

  return (
    <span ref={outer} class={shift ? 'marquee is-running' : 'marquee'} data-shift={shift || undefined}>
      <span ref={inner} class="marquee-text">
        {text}
      </span>
    </span>
  );
}
