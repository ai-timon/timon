---
title: Remote access to the web interface
sidebar_position: 8
---

You installed Timon on a server (a VPS, a home server, a machine without a screen) and now you cannot open the web interface from your own computer or phone. That is the intended behaviour: **Timon only listens on the machine itself until you decide otherwise.** This page shows how to decide, safely. For the whole setup of a server that runs around the clock (service, updates, and driving it from the Timon on your computer), start with [Run Timon on a headless server](headless-server.md).

:::tip The short version
1. On the server, make sure the web app runs: `timon app status`.
2. From your computer, open an SSH tunnel and finish the [first run](first-run.md) through it ([below](#step-0-finish-the-first-run-through-an-ssh-tunnel)).
3. For everyday access from your phone or laptop, use **[Tailscale](#method-a-tailscale-recommended)**. No port is opened to the internet.
4. Only if you need a public address, put a [reverse proxy with HTTPS](#method-c-reverse-proxy-with-https) or a [Cloudflare Tunnel](#method-d-cloudflare-tunnel) in front, and keep Timon itself on the loopback.
:::

## How access works

Timon runs two network listeners on the server:

| What | Setting | Default | Who connects to it |
| --- | --- | --- | --- |
| **Web interface** (the page you open in a browser) | `app.listen` | `127.0.0.1:3100` | Browsers |
| **Daemon API** | `daemon.listen` | `127.0.0.1:3000` | The `timon` command, agents, MCP clients, and the web interface itself |

The defaults are a starting point: the desktop package and your own configuration can choose other ports. Read the real values from `~/.timon/timon.config.json`, from `timon app status` (it prints the web app's address and whether it is running), or from the *Daemon listener* row of **Settings → Access & network → Web interface → Technical details**. The rest of this page writes `3100` for the web interface port; replace it with yours.

`127.0.0.1` is the **loopback**: only programs on the server itself can reach it. Everything below keeps both listeners there and brings the *browser* to the web interface by another road.

A few rules hold for every method:

- **Point everything at the web interface port, never at the daemon port.** A browser only needs the web interface. The daemon API stays on the loopback in every setup on this page. The one exception is [Machines](../usage/machines.md): to drive this server from the Timon on another computer, its daemon gets its own HTTPS address on your tailnet, through `tailscale serve`, as described in [Run Timon on a headless server](headless-server.md#4-drive-it-from-the-timon-on-your-computer).
- **Never publish a port straight onto a public interface.** Keep the loopback and put a private network, a tunnel or an HTTPS proxy in front.
- **Create your account before you open any access.** [Step 0](#step-0-finish-the-first-run-through-an-ssh-tunnel) does it through a tunnel that nobody else can use. As a second lock, once the web interface listens on something other than the loopback (or `daemon.behindTlsProxy` is set), the first-run form asks for a one-time setup token that only someone logged in on the server can print (`timon setup-token`), and nothing else answers a visitor who has not signed in.
- **Never set `daemon.auth` to `"off"`.** Timon refuses to start with it as soon as the daemon or the web interface listens beyond the loopback, or `daemon.behindTlsProxy` is set.
- **Everyone who can reach the sign-in page can try to sign in.** Anyone who gets in and holds the *open a terminal* permission has a shell as the user running Timon: see [Who can open a terminal](../usage/terminal.md#who-can-open-a-terminal).

## Step 0: finish the first run through an SSH tunnel

On a server there is no desktop window to run the setup in. Do it from your own computer, through SSH, before exposing anything.

**On the server**, check that the web app is running:

```bash
timon app status
```

It should report a running web app and an address such as `127.0.0.1:3100`. If it says the app is disabled or not built, see [Troubleshooting](#troubleshooting).

**On your computer**, open the tunnel (replace the user and host with yours):

```bash
ssh -N -L 3100:127.0.0.1:3100 you@your-server
```

Leave it running and open `http://127.0.0.1:3100` in your browser. Complete the [first run](first-run.md): create your administrator account there.

If you opened a listener before creating the account, the form shows a *Setup token* field. On the server, run:

```bash
timon setup-token
```

Paste the result into the form. The token works once and disappears when the first account exists.

If port 3100 is already used on your computer, choose another local port, for example `-L 8100:127.0.0.1:3100`, and open `http://127.0.0.1:8100`.

**With a graphical SSH client**, create the same forwarding rule: in PuTTY, *Connection → SSH → Tunnels*, source port `3100`, destination `127.0.0.1:3100`, **Add**, then **Open**. Other clients (Termius, MobaXterm…) have an equivalent *local port forwarding* screen.

The tunnel stays useful for the rest of the page: it is your way back in if a method below is misconfigured, as long as Timon still listens on the loopback (everything here except a specific address in [method E](#method-e-listen-directly-last-resort)).

## Choose a method

| Method | Reachable from | Exposed to the internet | Needs | Use it when |
| --- | --- | --- | --- | --- |
| [A. Tailscale](#method-a-tailscale-recommended) | Your own devices | No | A Tailscale account | **Default choice.** Phone and laptop access, installable as an app |
| [B. SSH tunnel](#method-b-ssh-tunnel) | One computer at a time | No | SSH access | Occasional access, nothing to install on the server |
| [C. Reverse proxy with HTTPS](#method-c-reverse-proxy-with-https) | Anyone with the address | Yes | A domain name, ports 80 and 443 | You need a public address you control |
| [D. Cloudflare Tunnel](#method-d-cloudflare-tunnel) | Anyone with the address | Yes | A Cloudflare account and domain | A public address without opening any port on the server |
| [E. Listening directly](#method-e-listen-directly-last-resort) | Whoever the firewall lets in | Depends on the firewall | A firewall rule | Last resort, private network only |

Method B changes nothing in Timon. Methods A, C and D add one line (`daemon.behindTlsProxy`, which only hardens the session cookie in method A). Method E changes where the web interface listens.

## Method A: Tailscale (recommended)

[Tailscale](https://tailscale.com/) links your devices in a private network (a *tailnet*) and gives the server an HTTPS address that only your devices can open. No port is opened on the server, and the address is HTTPS, so browsers also allow installing Timon as an app.

### From the interface

Open the interface through the tunnel of step 0, then **Settings → Access & network → Web interface**. The tab tells you, from the server's own point of view, what is done and what is missing:

- **Remote access** shows *Tailscale not installed*, *Tailscale is stopped*, *Not published yet* or *Ready* (with the address to open).
- A numbered list gives the **exact commands for this server**, with the right port already filled in: install Tailscale, connect the server to your tailnet, publish Timon over HTTPS. Run them on the server; the tab ticks each step off by itself.
- **Security** and **Install as an app** tell you whether the listener, the sign-in and the address are in the state you want.

The tab only reads the configuration and runs nothing: each command has a **Copy** button, and you run it yourself in the server's terminal.

### From the command line

On the server:

```bash
# 1. Install Tailscale. Follow https://tailscale.com/download for your distribution.
# 2. Connect the server to your tailnet. It prints a link to open on another device.
#    (Leave out sudo if your Tailscale installation does not need it.)
sudo tailscale up
# 3. Publish the web interface over HTTPS, on your tailnet only.
sudo tailscale serve --bg --https=443 http://127.0.0.1:3100
```

Check what is published, and which address to use:

```bash
tailscale serve status
```

The address looks like `https://<server>.<your-tailnet>.ts.net`. Open it from any device signed into the same Tailscale account.

Two switches in the [Tailscale admin console](https://login.tailscale.com/admin/dns) must be on: **MagicDNS** and **HTTPS certificates**. Without them the `serve` command refuses to publish.

Then tell Timon that HTTPS ends in front of it, so session cookies carry the *Secure* flag. Add this to `~/.timon/timon.config.json` and [restart the daemon](#apply-a-configuration-change):

```json
{
  "daemon": { "behindTlsProxy": true }
}
```

(Merge it with the existing `daemon` object; do not replace the file.)

To stop publishing:

```bash
sudo tailscale serve reset
```

:::warning Serve, not Funnel
`tailscale serve` shares with your tailnet only. **Tailscale Funnel** publishes the same service on the public internet: do not use it for Timon's web interface.
:::

Remove devices you no longer use from the tailnet: every device on it can reach the sign-in page.

## Method B: SSH tunnel

The tunnel of [step 0](#step-0-finish-the-first-run-through-an-ssh-tunnel) is a complete method on its own: nothing is installed on the server beyond SSH, and nothing is reachable by anyone but you.

```bash
ssh -N -L 3100:127.0.0.1:3100 you@your-server
```

Then open `http://127.0.0.1:3100` while the command runs. `127.0.0.1` counts as a secure context for your browser, so installing as an app works too.

To keep the tunnel up on a computer you use every day, use your SSH client's saved sessions or `autossh`. The limits are the ones of a tunnel: it works from the computer that opened it, and from nowhere else (including your phone).

## Method C: reverse proxy with HTTPS

A reverse proxy answers on ports 80 and 443 with a certificate for your domain and forwards to Timon on the loopback. Timon does not terminate TLS itself.

Before you start:

- The domain's DNS record points to the server.
- The firewall allows ports 80 and 443 (see [Ports and firewall](#ports-and-firewall)).
- Timon keeps `app.listen.host` at `127.0.0.1`.

The proxy must forward the **`Host`** header unchanged and tell Timon the original scheme with **`X-Forwarded-Proto`**: Timon builds its redirects from them, and a proxy that drops them sends you back to `http://127.0.0.1:3100` after sign-in. The interface also uses WebSockets (the built-in terminal) and live event streams, so the proxy must let them through.

### Caddy

Caddy gets and renews the certificate itself, forwards the right headers and handles WebSockets by default. In `/etc/caddy/Caddyfile`:

```caddy
timon.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

```bash
sudo systemctl reload caddy
```

### nginx

With a certificate from your own tool (for example `certbot`):

```nginx
server {
    listen 443 ssl;
    server_name timon.example.com;

    ssl_certificate     /etc/letsencrypt/live/timon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/timon.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;

        # WebSockets (built-in terminal) and live event streams
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}

# In the http { } block:
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Traefik, HAProxy and the proxy of your hosting panel work the same way: forward to `127.0.0.1:3100`, keep `Host`, set `X-Forwarded-Proto`, allow WebSockets.

### Tell Timon it is behind HTTPS

Add this to `~/.timon/timon.config.json` and [restart the daemon](#apply-a-configuration-change):

```json
{
  "daemon": { "behindTlsProxy": true }
}
```

Open `https://timon.example.com`. **Settings → Access & network → Web interface → Technical details → Session cookies** should read *Secure: HTTPS ends at a reverse proxy*. Timon's own sign-in is the access control: anyone can reach the page, and only people with an account get in. If you want a second layer, restrict the proxy to your own IP addresses.

## Method D: Cloudflare Tunnel

A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) makes the server dial out to Cloudflare, which then serves your domain over HTTPS. No inbound port is opened on the server. It is **public**: anyone on the internet can reach the sign-in page unless you add a Cloudflare Access policy in front of it, which is strongly recommended for Timon.

### From the Cloudflare dashboard

In the Cloudflare Zero Trust dashboard, create a tunnel and choose the Linux installer: the dashboard shows the one command to run on your server. Then add a **public hostname** (for example `timon.example.com`) whose service is `http://127.0.0.1:3100`. Finally, create an **Access** application for that hostname, with a policy that only allows your email address.

### From the command line

On the server, after installing [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/):

```bash
cloudflared tunnel login
cloudflared tunnel create timon
cloudflared tunnel route dns timon timon.example.com
```

Create `~/.cloudflared/config.yml` (use the tunnel UUID printed by `create`):

```yaml
url: http://127.0.0.1:3100
tunnel: <Tunnel-UUID>
credentials-file: /home/<you>/.cloudflared/<Tunnel-UUID>.json
```

```bash
cloudflared tunnel run timon
```

Run it as a service, as Cloudflare's documentation describes, so it survives a reboot. Then set `daemon.behindTlsProxy` to `true` as in [method C](#tell-timon-it-is-behind-https).

Cloudflare Access is configured on Cloudflare's side; Timon needs nothing for it.

## Method E: listen directly (last resort)

Making the web interface listen on the server's network interfaces serves it over **plain HTTP**: your password, your session and everything you type in the terminal travel in clear text, and browsers will not offer to install Timon as an app. Use it only on a network you already trust (a private LAN, a VPN), behind a firewall rule that names who can connect, verified **before** the listener changes. In every other case, use method A.

Settings cannot change a listener: **Settings → Access & network → Web interface** only reads it. The order matters: **the firewall comes first, the listener second.** Until the firewall is verified, the web interface must stay on the loopback.

### 1. Put the firewall in place and check it

Keep a second SSH session open while you do this. Then, on the server:

```bash
sudo ufw status verbose
```

- If it says `Status: inactive`, `ufw` filters nothing: a rule added with `ufw allow` has no effect until it is enabled. Set it up as in [Ports and firewall](#ports-and-firewall) (default deny incoming, allow SSH **first**, then `sudo ufw enable`).
- If it is active, the line `Default:` must read `deny (incoming)`. With `allow (incoming)`, every port is open whatever the rules say.
- Look for rules that already open the port: `sudo ufw status numbered | grep -E '3100|Anywhere'`. A rule such as `3100/tcp ALLOW IN Anywhere` makes the next rule pointless; remove it with `sudo ufw delete <number>`. Do not use `ufw reset`: it drops the SSH rule and cuts you off.
- Check the **firewall of your hosting provider** too (security group, cloud firewall): it applies before `ufw`.

Then allow only the address or network that may connect, and check the result:

```bash
sudo ufw allow from 203.0.113.10 to any port 3100 proto tcp
sudo ufw status numbered
```

The only line that mentions `3100` must carry your source address, not `Anywhere`.

### 2. Change the listener, then restart

Only now edit `~/.timon/timon.config.json`:

```json
{
  "app": {
    "enabled": true,
    "listen": { "host": "0.0.0.0", "port": 3100 }
  }
}
```

`0.0.0.0` means every interface, public ones included, which is why the firewall had to be right first. [Restart the daemon](#apply-a-configuration-change), then confirm from a machine **outside** the allowed addresses that `http://<server-ip>:3100` does not answer.

If you set a specific address instead (for example `10.0.0.5`), the web interface answers on that address **only**: it no longer answers on `127.0.0.1`. Your SSH tunnel must then target `10.0.0.5:3100`, and integrations that call the web interface on the loopback, such as the Telegram channel, stop working. `0.0.0.0` avoids both.

**Change `app.listen.host`, not `daemon.listen.host`.** The first one exposes the web interface, which has a sign-in page. The second one exposes the whole daemon API, which is for the command line, agents and the web interface itself. If you set the daemon beyond the loopback anyway, Timon requires authentication (`daemon.auth` cannot be `"off"`), refuses to create the first account without the daemon token, and forces the *Secure* flag on session cookies, which a plain-HTTP page cannot keep. A daemon bound beyond the loopback is for a private network only.

## Ports and firewall

| Port | Used by | Open to the internet? |
| --- | --- | --- |
| `22/tcp` | SSH | Yes, since it is how you manage the server. Keep key-based sign-in. |
| `3100/tcp` (`app.listen.port`) | Web interface | **No.** Stays on the loopback, except in method E on a private network |
| `3000/tcp` (`daemon.listen.port`) | Daemon API | **Never.** For [Machines](../usage/machines.md), publish it on your tailnet with `tailscale serve`, still without opening the port |
| `80/tcp`, `443/tcp` | Your reverse proxy | Only in method C |
| none | Tailscale, SSH tunnel, Cloudflare Tunnel | Nothing to open: these connect outwards |

A default-deny firewall on Debian or Ubuntu, with `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp      # method C only
sudo ufw enable
sudo ufw status verbose
```

Allow SSH **before** you enable the firewall, or you lock yourself out. A `ufw allow` rule does nothing while `ufw` is inactive, and an existing rule that opens a port to `Anywhere` is not narrowed by a second rule that names one address: read `sudo ufw status verbose` and `sudo ufw status numbered`, and delete the broad rule. Your hosting provider may also have its own firewall in front of the server: the same rules apply there.

Check what is really listening:

```bash
ss -ltn | grep -E ':(3000|3100)\b'
```

The *Local Address* column should read `127.0.0.1:3100` and `127.0.0.1:3000` (and `[::1]` for the same ports). `0.0.0.0` or `*` means the listener is open to every interface.

:::warning Docker bypasses ufw
A port published by Docker is opened by Docker's own firewall rules, before `ufw` sees it. If part of your installation runs in containers, publish ports on the loopback only (`127.0.0.1:3100:3100` in a Compose file) and see [Docker](docker.md).
:::

## Apply a configuration change

Changes to listeners and to `daemon.behindTlsProxy` take effect when the daemon restarts. On Linux, a package (deb or AppImage) runs its daemon as the user unit `timon-desktop-<id>`, named after your data directory; a source checkout's `timon service install` uses `timon-orchestrator`. `timon service status` names yours:

```bash
timon service status
systemctl --user restart timon-desktop-<id>    # or timon-orchestrator for a source checkout
timon app status
```

If `systemctl` reports no such unit, list the Timon units of your account with `systemctl --user list-unit-files 'timon-*'` and restart the one that belongs to your data directory.

Restart when no mission is running: it interrupts active work. See [Running in the background](background.md) for macOS and Windows, and [Configuration](configuration.md) for the file itself.

## Keep it safe

- **Accounts first.** Create your account through the tunnel (step 0) before any other method. Check them with `timon user list`. To invite others, use the **Team** page of the Multi-user plugin.
- **One strong password per person.** Sign-in attempts are throttled and locked out after repeated failures; that slows an attacker down, it does not replace a good password.
- **Review who holds the terminal permission.** See [Who can open a terminal](../usage/terminal.md#who-can-open-a-terminal).
- **Revoke what you no longer use:** devices on the tailnet, Access policies, `ufw` rules, tunnels.
- **Run the check.** **Settings → Access & network → Web interface** shows *Security: Needs attention* when there is no account yet, when login is turned off, or when the daemon listens beyond the loopback without enforced login. `timon doctor` checks the host's tools and configuration.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Connection refused or timeout on `http://<server-ip>:3100` | The web interface listens on the loopback only. This is the default | Use one of the methods above. Do not open the port |
| `timon app status` says the app is **disabled** | `app.enabled` is `false`: the daemon does not serve the web interface | Set `"app": { "enabled": true }` in `timon.config.json`, then [restart](#apply-a-configuration-change) |
| `timon app status` says the app is **not built** | A source installation without the built web app | Build it as in [Linux](linux.md#from-an-authorised-source-checkout) |
| The log says the port is already used | Another process, or a container, has the web interface port | Stop it, or change `app.listen.port`. Never run the container and the daemon-managed app together |
| `502 Bad Gateway` from your proxy or tunnel | The proxy points at a wrong port, or the web app is not running | Compare the proxy target with `timon app status` and `ss -ltn` |
| After signing in, you land on `http://127.0.0.1:3100` or on the wrong scheme | The proxy drops `Host` or `X-Forwarded-Proto` | Forward both, as in [method C](#method-c-reverse-proxy-with-https) |
| Signing in seems to do nothing, or loops back to the sign-in page | The session cookie is flagged *Secure* but the page is plain HTTP on a non-local address | Browse over HTTPS (methods A, C, D). If the daemon listens beyond the loopback, move it back to `127.0.0.1`. If you set `behindTlsProxy` without a proxy, set it back to `false`. Some browsers do not keep a *Secure* cookie on plain `http://127.0.0.1` either: if sign-in loops through an SSH tunnel after you turned `behindTlsProxy` on, use the HTTPS address |
| The built-in terminal or live updates freeze behind nginx | WebSocket headers or buffering | Add the `Upgrade`, `Connection` and `proxy_buffering off` lines of [method C](#nginx) |
| `tailscale serve` refuses to publish | HTTPS certificates or MagicDNS are not enabled for your tailnet | Enable both in the Tailscale admin console, then run the command again |
| *Tailscale is stopped* in the Web interface tab | The server is not connected to the tailnet | Run `sudo tailscale up` on the server |
| The tailnet address does not load from your phone | The phone is not signed into the same Tailscale account, or nothing is published | Check `tailscale serve status` on the server, and the Tailscale app on the phone |
| First account refused: *Setup token missing or wrong* | A listener is not on the loopback, so the form asks for the one-time token | Run `timon setup-token` on the server and paste the result, or put the listeners back on `127.0.0.1`, restart, and create the account through the tunnel of step 0 |
| The daemon does not start, exit code 2, the log mentions authentication being disabled on a non-loopback interface | `daemon.auth` is `"off"` while the daemon listens beyond the loopback | Remove the `auth` line (the default is `"auto"`), or set the host back to `127.0.0.1` |
| The daemon does not start, exit code 2, the log says `daemon.auth is "off"` while the web interface listens beyond the loopback, or with `daemon.behindTlsProxy` | Disabling authentication would let anyone who reaches the web interface use the whole API without signing in | Remove the `auth` line (the default is `"auto"`), or put `app.listen.host` back on `127.0.0.1` and unset `daemon.behindTlsProxy` |
| *Too many attempts*, a `429` | Repeated failed sign-ins | Wait for the delay shown, then try again. Forgotten password: `timon user reset-password <email>` on the server |
| The page loads, but *Install as an app* is unavailable | The address is plain HTTP and not local | Use an HTTPS address (methods A, C, D) or the tunnel's `127.0.0.1` |

If a symptom is not here, the daemon log has the answer: `journalctl --user -u timon-orchestrator -n 100` on Linux. See [Troubleshooting](troubleshooting.md) for the general table.
