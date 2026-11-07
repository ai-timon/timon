import { Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { accentVars } from '@/lib/accent-color';

/** An icon-logo is a URL (http(s) or `/api/uploads/...` path served by
 *  TIMON); otherwise it's an emoji. Same heuristic as projects-client. */
function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/');
}

type Size = 'xs' | 'sm' | 'md';

const SIZE: Record<Size, string> = {
  xs: 'text-[10.5px] px-1.5 py-0 gap-0.5',
  sm: 'text-[10.5px] px-1.5 py-0.5 gap-1',
  md: 'text-[12px] px-2 py-1 gap-1.5',
};

const ICON: Record<Size, string> = {
  xs: 'size-2.5',
  sm: 'size-3',
  md: 'size-3.5',
};

// Size (px) of the emoji/image logo — a touch bigger than the lucide icon
// to stay readable.
const LOGO_PX: Record<Size, number> = { xs: 11, sm: 13, md: 15 };

export function ProjectBadge({
  project,
  color,
  icon,
  size = 'sm',
  withIcon = true,
  className,
}: {
  project: string | null | undefined;
  /** Real project color (hex). Without one the chip is neutral. */
  color?: string | null;
  /** Real logo: emoji or image URL. Falls back to the Folder icon. */
  icon?: string | null;
  size?: Size;
  withIcon?: boolean;
  className?: string;
}) {
  if (!project) return null;

  // An explicit colour is published as CSS variables and picked by the theme:
  // a project painted near-black is invisible on the dark background, and
  // reading the theme in JS would flash the wrong colour after hydration.
  // Without a colour the chip stays neutral: a hue guessed from the slug
  // painted lime and magenta chips the project never chose.
  const style = color ? accentVars(color) : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border font-medium whitespace-nowrap',
        !color && 'border-transparent bg-foreground/[0.06] text-muted-foreground',
        color &&
          'bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] dark:bg-[var(--accent-soft-dark)] dark:border-[var(--accent-border-dark)] dark:text-[var(--accent-dark)]',
        SIZE[size],
        className,
      )}
      style={style}
      title={`project: ${project}`}
    >
      {withIcon && <ProjectLogo icon={icon} size={size} />}
      {project}
    </span>
  );
}

function ProjectLogo({ icon, size }: { icon?: string | null; size: Size }) {
  if (!icon) return <Folder className={ICON[size]} />;
  if (isUrl(icon)) {
    const px = LOGO_PX[size];
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={icon} alt="" style={{ width: px, height: px, objectFit: 'contain' }} />
    );
  }
  return <span style={{ fontSize: LOGO_PX[size], lineHeight: 1 }}>{icon}</span>;
}
