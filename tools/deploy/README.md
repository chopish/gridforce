# GridForce auto-deploy

Push to `main` → GitHub fires a webhook → VM pulls, builds, and restarts.

```
GitHub  ──push──▶  nginx :443 /webhook  ──▶  webhook-server.mjs :9000
                                                      │
                                                      ▼
                                                deploy.sh
                                                  ├─ git fetch + reset --hard origin/main
                                                  ├─ npm ci
                                                  ├─ npm run typecheck && build
                                                  └─ sudo systemctl restart gridforce
```

## Files

| File                          | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `webhook-server.mjs`          | Zero-dep Node receiver, HMAC-verifies, runs `deploy.sh`       |
| `deploy.sh`                   | Pulls, installs, builds, restarts the game server             |
| `gridforce.service`           | systemd unit for the game server                              |
| `gridforce-webhook.service`   | systemd unit for the webhook receiver                         |
| `gridforce.sudoers`           | Lets the `gridforce` user restart its own service             |
| `nginx.conf`                  | Unified nginx site (TLS, /webhook, /ws, /api, static client)  |

## One-time VM bootstrap

Run as a sudoer on the VM. Replace `YOUR_DOMAIN` and `YOUR_GITHUB_REPO`.

```bash
# 1. user, dirs, secrets dir
sudo useradd --system --create-home --shell /bin/bash gridforce
sudo mkdir -p /opt/gridforce /etc/gridforce
sudo chown gridforce:gridforce /opt/gridforce

# 2. clone the repo as the gridforce user
sudo -u gridforce git clone https://github.com/YOUR_GITHUB_REPO.git /opt/gridforce

# 3. generate a webhook secret and store it
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "WEBHOOK_SECRET=$WEBHOOK_SECRET" | sudo tee /etc/gridforce/webhook.env > /dev/null
sudo chmod 600 /etc/gridforce/webhook.env
sudo chown gridforce:gridforce /etc/gridforce/webhook.env
echo "Save this for the GitHub webhook setup: $WEBHOOK_SECRET"

# 4. install systemd units
sudo cp /opt/gridforce/tools/deploy/gridforce.service /etc/systemd/system/
sudo cp /opt/gridforce/tools/deploy/gridforce-webhook.service /etc/systemd/system/
sudo cp /opt/gridforce/tools/deploy/gridforce.sudoers /etc/sudoers.d/gridforce
sudo chmod 0440 /etc/sudoers.d/gridforce
sudo systemctl daemon-reload

# 5. first build (so the service has something to start)
cd /opt/gridforce
sudo -u gridforce npm ci
sudo -u gridforce npm run build

# 6. start services
sudo systemctl enable --now gridforce gridforce-webhook
sudo systemctl status gridforce gridforce-webhook --no-pager

# 7. nginx + TLS. Get a cert first if you don't have one:
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot certonly --nginx -d your.domain.example   # only if no cert exists yet

# Install unified site config and disable conflicting defaults.
sudo cp /opt/gridforce/tools/deploy/nginx.conf /etc/nginx/sites-available/gridforce
sudo sed -i "s/grid\.clab\.su/your.domain.example/g" /etc/nginx/sites-available/gridforce  # if your domain differs
sudo ln -sf /etc/nginx/sites-available/gridforce /etc/nginx/sites-enabled/gridforce
sudo unlink /etc/nginx/sites-enabled/default 2>/dev/null || true
sudo nginx -t && sudo systemctl reload nginx
```

> No domain? You can have GitHub deliver the webhook directly to `http://VM_PUBLIC_IP:9000/webhook` if you change the receiver's `listen` from `127.0.0.1` back to `0.0.0.0` and open port 9000. **Not recommended** — GitHub allows plain-HTTP webhooks but the secret is your only protection on the wire.

## GitHub webhook setup

1. Repo → **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://your.domain.example/webhook`
3. **Content type:** `application/json`
4. **Secret:** the value of `WEBHOOK_SECRET` from step 3 above
5. **Which events:** *Just the push event*
6. **Active:** ✓
7. Save → GitHub sends a `ping` → check `journalctl -u gridforce-webhook -f` for `ping received`

## Day-to-day

```bash
# tail deploy logs
sudo journalctl -u gridforce-webhook -f

# tail the game server
sudo journalctl -u gridforce -f

# manual deploy (same script the webhook runs)
sudo -u gridforce /opt/gridforce/tools/deploy/deploy.sh

# rotate webhook secret
sudo nano /etc/gridforce/webhook.env  # update WEBHOOK_SECRET
sudo systemctl restart gridforce-webhook
# then update the secret in the GitHub webhook settings
```

## Notes & gotchas

- Deploy uses `git reset --hard origin/main` — any local changes on the VM are discarded. Don't edit code on the VM.
- Concurrent pushes are debounced: a second push during a deploy queues exactly one follow-up.
- The receiver listens on `127.0.0.1` only; nginx is the public entrypoint.
- The webhook only triggers on pushes to `main` (override with `DEPLOY_BRANCH` in `webhook.env`).
- The `gridforce` user has `NOPASSWD` sudo for *only* `systemctl restart gridforce` — nothing else.
