import { cn } from '@/lib/utils';

type KpiProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  delta?: React.ReactNode;
  bad?: boolean;
  accent?: boolean;
  className?: string;
};

export function Kpi({ label, value, unit, delta, bad, accent, className }: KpiProps) {
  return (
    <div
      className={cn(
        // Surface contrast, not an outline, like the other cards; the accented
        // figure keeps its warm gradient.
        'relative flex flex-col justify-between gap-2 overflow-hidden rounded-xl bg-card p-4',
        accent && 'bg-gradient-to-b from-primary/10 to-primary/[0.02]',
        className,
      )}
    >
      <div className="text-[12.5px] font-medium text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'flex items-baseline gap-1.5 tabular-nums text-[30px] font-semibold leading-none -tracking-[0.01em]',
          accent ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
        {unit && (
          <span className="font-sans text-xs font-medium text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-1 inline-flex items-center gap-1 tabular-nums text-[11.5px] font-medium',
            bad ? 'text-destructive' : 'text-[hsl(var(--success))]',
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
