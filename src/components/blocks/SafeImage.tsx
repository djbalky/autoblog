/**
 * Autonoblog — an `<img>` that degrades gracefully (Phase 5d).
 *
 * A published article can reference an image that no longer resolves (an
 * external URL that 404s, a file removed from disk). The browser's own answer is
 * a broken-image icon, which looks like a bug in the page. This component keeps
 * the same markup and layout but swaps the image for a neutral, styled
 * placeholder the moment the load fails — the caption, alt text and spacing
 * around it stay exactly where they were.
 *
 * It is used by the SHARED block renderer, so the editor preview degrades the
 * same way the public page does. The first render is always the real `<img>`
 * (identical on the server and on the client, so hydration matches); only a real
 * client-side load error switches it.
 */
import { useEffect, useRef, useState } from "react";

export function SafeImage({
  src,
  alt,
  className,
  placeholderClassName,
}: {
  src: string;
  alt: string;
  className?: string;
  placeholderClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement | null>(null);

  // A broken image can finish failing BEFORE React hydrates, in which case no
  // `error` event ever reaches the handler below. Check the already-settled
  // state once after mount (complete + zero intrinsic width = it failed).
  useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={alt ? `${alt} (image unavailable)` : "Image unavailable"}
        className={
          placeholderClassName ??
          "flex min-h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-300 bg-neutral-100 px-4 py-8 text-center"
        }
      >
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
          Image unavailable
        </span>
        {alt ? <span className="max-w-md text-xs text-neutral-400">{alt}</span> : null}
      </div>
    );
  }

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
