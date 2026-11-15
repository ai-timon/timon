'use client';

/**
 * The account's own page: name, picture, login email, password, and the
 * licence key of the instance (`LicenseSection`), and the agency offer
 * (`AgencyOfferRow`) for an account that uses Timon for an agency.
 *
 * Reachable by EVERY signed-in account (see `SELF_SERVICE_PAGES`), for the
 * same reason password rotation is: an identity one has to ask a superadmin to
 * edit is an identity people end up sharing.
 *
 * The email is the one field that does not save on the spot — see
 * `EmailSection`.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Copy, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordDialog } from '@/components/password-dialog';
import { UserAvatar, joinName, splitName } from '@/components/user-avatar';
import { refreshMe, useMe } from '@/hooks/use-me';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import type { PublicUser } from '@/lib/auth';
import { t } from '@/lib/i18n';
import { LicenseSection } from './license-section';
import { AgencyOfferRow } from '@/components/settings/agency-offer-row';

/** Section chrome, so the three blocks below read as one page. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="m-0 text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

function IdentitySection({ user }: { user: PublicUser }): ReactElement {
  const initial = splitName(user.name);
  const [first, setFirst] = useState(initial.first);
  const [last, setLast] = useState(initial.last);
  const [busy, setBusy] = useState(false);
  const [avatarSource, setAvatarSource] = useState<LogoCropSource | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The saved name is the source of truth: another tab, or a superadmin
  // renaming the account, must not be overwritten by a stale draft.
  useEffect(() => {
    const parts = splitName(user.name);
    setFirst(parts.first);
    setLast(parts.last);
  }, [user.name]);

  async function patch(body: Record<string, unknown>, success: string): Promise<void> {
    const response = await fetch('/api/ui/auth/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readError(response, t('profile.saveError')));
    await refreshMe();
    toast.success(success);
  }

  async function saveName(): Promise<void> {
    const name = joinName(first, last);
    if (!name) {
      toast.error(t('profile.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      await patch({ name }, t('profile.saved'));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pickAvatar(file: File | null | undefined): void {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.imageInvalid'));
      return;
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      toast.error(t('profile.imageTooLarge'));
      return;
    }
    // A profile picture is shown in a circle too: same framing dialog, same
    // zoom and background controls as a project logo or an agent avatar.
    setAvatarSource(file);
  }

  return (
    <Section title={t('profile.identityTitle')} description={t('profile.identityDescription')}>
      <div className="flex flex-wrap items-center gap-4">
        <UserAvatar user={user} className="size-16 text-base" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => { pickAvatar(event.target.files?.[0]); event.target.value = ''; }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={avatarSource !== null}
            onClick={() =>
              user.avatar_url ? setAvatarSource(user.avatar_url) : fileRef.current?.click()
            }
          >
            <Upload className="size-3.5" />
            {t('profile.avatarUpload')}
          </Button>
          {user.avatar_url && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={avatarSource !== null}
              onClick={() => fileRef.current?.click()}
            >
              {t('profile.avatarReplace')}
            </Button>
          )}
          <LogoCropDialog
            source={avatarSource}
            endpoint="/api/uploads/avatars"
            onCancel={() => setAvatarSource(null)}
            onUploaded={(url) => {
              setAvatarSource(null);
              void patch({ avatar_url: url }, t('profile.avatarSaved')).catch((e: Error) =>
                toast.error(e.message),
              );
            }}
          />
          {user.avatar_url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={avatarSource !== null}
              onClick={() => { void patch({ avatar_url: null }, t('profile.avatarRemoved')).catch((e: Error) => toast.error(e.message)); }}
            >
              <Trash2 className="size-3.5" />
              {t('profile.avatarRemove')}
            </Button>
          )}
        </div>
      </div>

      <form
        className="mt-5 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => { event.preventDefault(); void saveName(); }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-first">{t('profile.firstName')}</Label>
          <Input
            id="profile-first"
            autoComplete="given-name"
            value={first}
            onChange={(event) => { setFirst(event.target.value); }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-last">{t('profile.lastName')}</Label>
          <Input
            id="profile-last"
            autoComplete="family-name"
            value={last}
            onChange={(event) => { setLast(event.target.value); }}
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={busy || joinName(first, last) === user.name}>
            {busy ? t('profile.saving') : t('profile.save')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/**
 * Moving the login identity.
 *
 * The daemon parks the address until the confirmation link is followed, and
 * there is no mailer in the product — invitations are handed over the same
 * way. So the link is shown here to be copied and sent; nothing pretends an
 * email went out. Every superadmin is notified daemon-side.
 */
function EmailSection({ user }: { user: PublicUser }): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch('/api/ui/auth/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, current_password: password }),
      });
      if (!response.ok) {
        toast.error(await readError(response, t('profile.emailError')));
        return;
      }
      const body = await response.json() as { token: string };
      setLink(`${window.location.origin}/confirm-email/${encodeURIComponent(body.token)}`);
      setPassword('');
      toast.success(t('profile.emailRequested'));
    } catch (error) {
      // Without this the request just fails silently: `finally` clears the
      // spinner and nothing on screen changes.
      toast.error((error as Error).message || t('profile.emailError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t('profile.emailTitle')} description={t('profile.emailDescription')}>
      <p className="text-xs text-muted-foreground">
        {t('profile.currentEmail')} <span className="font-medium text-foreground">{user.email}</span>
      </p>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email">{t('profile.newEmail')}</Label>
          <Input
            id="profile-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => { setEmail(event.target.value); }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email-password">{t('session.currentPassword')}</Label>
          <Input
            id="profile-email-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => { setPassword(event.target.value); }}
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={busy || !email.trim() || password.length === 0}>
            {busy ? t('profile.emailSending') : t('profile.emailSubmit')}
          </Button>
        </div>
      </form>

      {link && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">{t('profile.emailLinkHint')}</p>
          <p /* code-font: link to copy */ className="mt-2 break-all font-mono text-[11px]">{link}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void navigator.clipboard.writeText(link)
                .then(() => toast.success(t('profile.emailLinkCopied')))
                .catch(() => toast.error(t('profile.emailLinkCopyFailed')));
            }}
          >
            <Copy className="size-3.5" />
            {t('profile.emailLinkCopy')}
          </Button>
        </div>
      )}
    </Section>
  );
}

function PasswordSection(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Section title={t('session.changePassword')} description={t('session.passwordHint')}>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('session.changePassword')}
      </Button>
      <PasswordDialog open={open} onOpenChange={setOpen} />
    </Section>
  );
}

export function ProfileClient(): ReactElement {
  const me = useMe();
  const user = me?.user;

  if (!user) {
    return (
      <div className="relative z-[1] p-7 text-sm text-muted-foreground">{t('route.loading')}</div>
    );
  }

  return (
    <div className="relative z-[1] flex h-full flex-col gap-4 overflow-auto px-7 pt-5 pb-8">
      <div>
        <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('profile.eyebrow')}
        </h1>
        <div className="mt-1 text-[22px] font-semibold -tracking-[0.01em]">{t('profile.title')}</div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('profile.description')}</p>
      </div>
      <div className="grid max-w-3xl gap-4">
        <IdentitySection user={user} />
        <EmailSection user={user} />
        <PasswordSection />
        <LicenseSection canEdit={user.is_superadmin} />
        <AgencyOfferRow accountEmail={user.email} />
      </div>
    </div>
  );
}
