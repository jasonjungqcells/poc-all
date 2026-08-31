# AC Gen2 Edge Platform — Local Dev Environment Setup (macOS)

> Source: Confluence — [[AC GEN2] How to - Edge Build Environment and Installation](https://growingenergylabs.atlassian.net/wiki/spaces/EnergySW/pages/10177052708/AC+GEN2+How+to+-+Edge+Build+Environment+and+Installation)
> Subpages: [[AC GEN2] Repo group](https://growingenergylabs.atlassian.net/wiki/spaces/EnergySW/pages/11114152058), [[AC GEN2] B script](https://growingenergylabs.atlassian.net/wiki/spaces/EnergySW/pages/11114250442)
>
> The Confluence docs are written in Korean for **Windows + WSL2 Ubuntu/Debian x86_64**. This document translates them and adapts the plan for an **Apple Silicon MacBook**.
>
> 👉 **If your goal is the MPU/MCU layer and a SIL simulator, read [`AC-GEN2-MPU-MCU-SIL-PLAN.md`](./AC-GEN2-MPU-MCU-SIL-PLAN.md) instead** — that scope avoids the Yocto disk/architecture blockers described here. This document remains the reference for full-platform builds.
> - [`AC-GEN2-SIL-CONTROL-PLANE.md`](./AC-GEN2-SIL-CONTROL-PLANE.md) — control taxonomy + scenario catalog
> - [`sil-rig/`](./sil-rig/README.md) — **the implementation**: 155 controls, 140 scenarios, serving `:9112`

---

## 1. What kind of project is this?

This isn't a normal app repo. It's an **embedded Linux product**. The deliverable isn't a binary you `npm start` — it's a **complete operating system image** flashed onto an i.MX (NXP ARM) board inside a Qcells energy device.

The framework is the **Yocto Project** (release codename **kirkstone**). Yocto is a build *system* that compiles, from source:

- the Linux kernel + bootloader (U-Boot) for that specific board
- the cross-compiler toolchain (runs on x86_64, produces ARM64 binaries)
- hundreds of open-source packages (busybox, openssl, systemd, …)
- your own apps (`edge_uniep`, `edge_ac_system_gen2_application`, …)

…and packs it all into a flashable `.wic` / `.sdcard` image plus SWUpdate `.swu` update bundles.

That's why the doc talks about disk, Docker, and host-OS setup scripts rather than "clone and run."

---

## 2. Why isn't it just `git clone`?

### (a) It's 30+ separate git repos, not one

Yocto is organized as "layers" — each layer is its own git repo (`meta-qcells-edge`, `meta-qcells-bsp-emsplus`, `meta-ublox-modules`, …), plus upstream layers from NXP/Yocto (`poky`, `meta-freescale`, `meta-openembedded`). They must all be checked out at *mutually compatible* commits.

### (b) So they use `repo` on top of git

`repo` is Google's multi-repo tool (from Android). Source control is still **git** — `repo` is just an orchestrator:

- A **manifest XML** lists every repo, its remote URL, its branch/revision, and where to place it on disk.
- `repo init` downloads the manifest; `repo sync -j16` clones/updates all repos in parallel.
- `repo forall -g <group> -c '<git cmd>'` runs a git command across many repos at once.

### (c) The build needs a specific Linux host

Yocto's `bitbake` requires GNU tools, a **case-sensitive** filesystem, and ~150–250 GB of disk. macOS fails on all three (default APFS is case-*insensitive*, which corrupts Yocto builds).

---

## 3. The actual repos and URLs

### Entry point (the manifest repo)

| | |
|---|---|
| Manifest repo (GitHub) | `git@github.com:qcells-hqct/edge_repo` |
| Manifest repo (Bitbucket mirror) | `git@bitbucket.org:gelibitbucket/edge_repo` |
| Branch | `imx-linux-kirkstone-qcells-edge` |
| Manifest file | `qcells-edge_mirror.xml` (Qcells mirror — **recommended**) |
| Alt manifest | `qcells-edge.xml` (upstream/external origins — slower, flakier) |

```bash
repo init -u git@github.com:qcells-hqct/edge_repo \
          -b imx-linux-kirkstone-qcells-edge \
          -m qcells-edge_mirror.xml
repo sync -j16
```

### Repos the manifest pulls in (Qcells-owned)

**Platform / Yocto layers (group `p`)**

| Repo | What it is |
|---|---|
| `meta-qcells-edge` | Main Yocto layer (image recipes, distro config) |
| `meta-qcells-edge-apps` | Recipes that package the apps below |
| `meta-qcells-bsp-emsplus` | Board Support Package: kernel, U-Boot, device tree for EMS+ hardware |
| `meta-ublox-modules` | u-blox cellular/GNSS modem drivers |
| `edge_host_agent` | Host agent |
| `edge_ac_system_gen2_host` | Host-side companion component for AC Gen2 |

**Application code (added in group `a2` = AC Gen2 — your target)**

| Repo | What it is |
|---|---|
| `edge_uniep` | UniEP — core energy platform daemon |
| `edge_uniep_common` | Shared libraries |
| `edge_gcm_dec` | Grid/comms module decoder |
| `edge_web_interface` | Shared web UI framework |
| `edge_ac_system_gen2_application` | **AC Gen2 app logic** |
| `edge_ac_system_gen2_web` | **AC Gen2 web UI** |
| `edge_ac_system_gen2_application_extern` | Externally-distributed app variant |
| `edge_ac_system_gen2_web_extern` | Externally-distributed web variant |
| `qcells-cloud-server-nextgen-schemas` | Shared cloud API / message schemas |
| `on-prem-ai` | On-premise AI component |
| `edge_tools` | `build_yocto.sh`, `build_apps.sh`, `tools/b/` scripts |

**Other product line (group `f1`, not yours):** `edge_ftm_gen1_application`, `edge_ftm_gen1_web`

### Manifest groups

| Category | Group | Meaning |
|---|---|---|
| all | `a` | Every Qcells-managed repo |
| platform | `p` | Yocto layers + host/BSP |
| **ac_system_gen2** | **`a2`** | **platform + AC Gen2 apps ← use this** |
| ftm_gen1 | `f1` | platform (minus gen2 host) + FTM Gen1 apps |

```bash
repo forall -g a2 -c 'git checkout main'                # all AC Gen2 repos -> main
repo forall -g a2 -c 'git checkout TUE'                 # all AC Gen2 repos -> TUE tag
repo forall -g p  -c 'git checkout ac_system_gen2-v02'  # platform only -> tag
```

> The main doc's long `repo start main meta-qcells-edge meta-qcells-edge-apps …` command is the old, pre-groups way of doing the same thing.

---

## 4. Prerequisites before anything works

| Prerequisite | Why | Doc ref |
|---|---|---|
| **GitHub `qcells-hqct` org membership** | Repos are private (unauthenticated access returns 404) | — |
| **SSH key registered on GitHub** | `repo` uses `git@github.com:` SSH URLs, not HTTPS | §1.3.1 |
| **Bitbucket account + SSH key + App Password** | Only if using the Bitbucket mirror | §1.3.1 |
| **`~/.ssh/config` with port-443 hosts** | Corp firewalls block port 22; doc routes SSH over `ssh.github.com:443` / `altssh.bitbucket.org:443` | §1.3.2 |
| **Corp VPN** | Jenkins (`172.23.1.181:20001`) and the internal Docker mirror are private-network only | §2.3 / B script |
| **Docker** | `build_yocto.sh` runs bitbake *inside a container* — this is why GEN4 builds work from any host env | §1.2.4 |
| **Azure CLI** | Artifact pulls / device-update (ADU) work | §1.2.5 |
| **150–250 GB free disk** | Yocto downloads + sstate-cache + tmp | — |

### SSH config (doc §1.3.2)

```
Host bitbucket.org
    Hostname altssh.bitbucket.org
    Port 443

Host github.com
    Hostname ssh.github.com
    Port 443
```

### Host packages (doc §1.2.1 — Linux only)

```bash
sudo apt update && sudo apt install -y \
  gawk wget git diffstat unzip texinfo gcc build-essential \
  chrpath socat cpio python3 python3-pip python3-pexpect \
  xz-utils debianutils iputils-ping python3-git python3-jinja2 \
  libegl1-mesa libsdl1.2-dev xterm python3-subunit \
  mesa-common-dev zstd liblz4-tool ninja-build cmake \
  pylint locales rsync libncurses-dev libssl-dev curl file
```

### `repo` install (doc §1.2.2)

```bash
mkdir -p ~/.bin
curl https://storage.googleapis.com/git-repo-downloads/repo > ~/.bin/repo
chmod a+rx ~/.bin/repo
echo 'export PATH=~/.bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

> Ubuntu 18.04 only: use `repo-2.54` and pre-clone `git clone -b v2.54 https://gerrit.googlesource.com/git-repo .repo/repo`.

---

## 5. What the build scripts actually do

| Command | Effect |
|---|---|
| `./tools/set_hostos/set_hostos_environment_ubuntu20.04.sh` | **One-time.** Installs host packages, sets up container runtime. Pick the variant matching your OS (`debian12`, `ubuntu18.04`, `ubuntu20.04`) |
| `./tools/set_hostos/set_hostos_docker_mirror.sh` | **One-time.** Points Docker at the internal Qcells registry |
| `./build_yocto.sh all` | Full OS image build (hours) |
| `./build_apps.sh all` | Builds apps via AppLibBuilder → output in `<workdir>/result/` |
| `./make_uniep.sh` | Builds only UniEP |
| `./tools/b/b_install.sh` | Installs a global `b` command that **submits builds to Jenkins** instead of building locally |

### The `b` command (Jenkins dispatch)

```bash
b all                        # full Yocto build on Jenkins
b apps                       # all apps
b energy_link system_log     # specific apps only
```

- Jenkins: [DevEdge](http://172.23.1.181:20001/view/3_%EA%B0%9C%EB%B0%9C%EB%B9%8C%EB%93%9C/job/DevEdge/) (VPN required)
- Artifacts: `__BUILD_RESULT__/<timestamp>_apps` — includes `edge_arm64_debug`, build logs, and symlinks to app binaries
- Requires `edge_tools` to be up to date first

> **Sections 3–5 of the Confluence doc** (SWUpdate install/signing, ADU agent, `du-config.json`, Azure IoT connection string) are **device/target-side setup**, not needed for a laptop dev env.

---

## 6. The MacBook problem

Current machine: **Apple Silicon (arm64), macOS 26.5, 16 GB RAM, 12 cores, ~52 GB free.**

| Issue | Detail |
|---|---|
| **Wrong CPU architecture** | Docs assume x86_64. Internal Docker build images and the ADU/DeliveryOptimization `.deb`s are `amd64`. Docker Desktop can emulate x86_64 via Rosetta, but Yocto under emulation is painfully slow |
| **Not enough disk** ⚠️ | 52 GB available vs 150–250 GB needed. **Hard blocker for local Yocto builds** |
| **macOS can't build Yocto natively** | Needs case-sensitive FS + Linux. Everything must run inside a Linux VM/container |

---

## 7. Recommended plan

### Phase 0 — Access (start here; longest lead time)

1. Request GitHub `qcells-hqct` org access; confirm which team grants `edge_repo`.
2. Generate an SSH key on the Mac and add it to GitHub:
   ```bash
   ssh-keygen -t ed25519 -C "<your-email>"
   cat ~/.ssh/id_ed25519.pub
   ```
   GitHub → avatar → Settings → Access → SSH and GPG keys → New SSH key
3. Add the port-443 block to `~/.ssh/config`; verify with `ssh -T git@github.com`.
4. Obtain corp VPN access and a Jenkins DevEdge account.

### Phase 1 — Get the source (fits in 52 GB)

5. Install **Docker Desktop** (Apple Silicon build).
6. Create an **x86_64 Ubuntu 22.04 container** with a case-sensitive volume; install `repo` inside it.
7. Sync:
   ```bash
   repo init -u git@github.com:qcells-hqct/edge_repo \
             -b imx-linux-kirkstone-qcells-edge \
             -m qcells-edge_mirror.xml
   repo sync -j8
   ```
   Source tree alone is roughly 15–30 GB — fits.
8. `repo forall -g a2 -c 'git checkout main'`
9. Read/navigate AC Gen2 code from macOS via a bind mount.

### Phase 2 — Build without local Yocto (day-to-day workflow)

10. `./tools/b/b_install.sh`, then `b apps` → Jenkins builds, you download artifacts. **No 250 GB required.**

### Phase 3 — Local full build (optional)

11. Attach a 500 GB–1 TB external NVMe SSD. Format APFS *case-sensitive*, or better: place an ext4 disk image on it for the VM.
12. **Preferred alternative:** request a remote x86_64 Ubuntu 22.04 build box (16 vCPU / 32 GB / 500 GB) and use VS Code Remote-SSH. This matches the docs exactly and avoids fighting Rosetta emulation.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Yocto** | Build system that produces custom embedded Linux distributions from source |
| **kirkstone** | Yocto 4.0 LTS release codename — the version this project targets |
| **bitbake** | Yocto's task executor / build engine |
| **layer** (`meta-*`) | A git repo containing Yocto recipes, config, and patches |
| **recipe** (`.bb`) | Instructions for fetching, configuring, compiling, and packaging one component |
| **manifest** | XML file listing all repos + revisions for `repo` to sync |
| **`repo`** | Google's multi-repo orchestrator built on git |
| **BSP** | Board Support Package — kernel, bootloader, device tree for specific hardware |
| **sstate-cache** | Yocto's shared-state build cache (large; main disk consumer) |
| **SWUpdate** | Embedded update framework; consumes signed `.swu` bundles |
| **ADU** | Azure Device Update — cloud-driven OTA update agent |
| **UniEP** | Qcells' unified energy platform core daemon |
| **i.MX** | NXP ARM application processor family used on this board |
