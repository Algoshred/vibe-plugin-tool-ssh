# @vibecontrols/vibe-plugin-ssh

<!-- VIBECONTROLS_OSS_HEADER_START -->

> **License**: MIT — see [LICENSE](./LICENSE).
> **Note**: This plugin is open source. The `@vibecontrols/agent` runtime that loads it is **not** open source — it is a proprietary product of Burdenoff Consultancy Services Pvt. Ltd. See [vibecontrols.com](https://vibecontrols.com) for the agent.

<!-- VIBECONTROLS_OSS_HEADER_END -->

SSH connections & port forwarding plugin for [VibeControls Agent](https://www.npmjs.com/package/@vibecontrols/agent).

## Platform support

This plugin is **POSIX-only** for now (Linux, macOS, WSL). It shells out to
`ssh`, `scp`, `chmod`, `tar`, and uses `nohup` to launch `ttyd` on the remote
host. Native Windows support (cmd / PowerShell) is not yet implemented — the
plugin self-disables on `process.platform === "win32"` and the CLI subcommands
exit early with a "not supported on Windows yet" message. Track progress in the
issue tracker.

## Installation

```bash
vibe plugin install @vibecontrols/vibe-plugin-ssh
```

Or install globally alongside the agent:

```bash
npm install -g @vibecontrols/vibe-plugin-ssh
```

Then register it:

```bash
vibe plugin list  # verify it shows up
```

## Features

- **SSH Connections** — Save, test, and manage SSH connection configs
- **Remote Execution** — Execute commands on remote servers via SSH
- **Port Forwarding** — Create and manage SSH port forwards (local → remote)
- **Real-time Output** — SSH command output streamed via Socket.IO events

## API Routes

Once installed, the plugin registers these routes on the agent:

| Method | Path                          | Description                 |
| ------ | ----------------------------- | --------------------------- |
| GET    | `/api/ssh/connections`        | List all SSH connections    |
| POST   | `/api/ssh/connections`        | Create a new SSH connection |
| POST   | `/api/ssh/execute`            | Execute a remote command    |
| POST   | `/api/ssh/test/:id`           | Test an SSH connection      |
| DELETE | `/api/ssh/connections/:id`    | Delete a connection         |
| GET    | `/api/port-forward/`          | List all port forwards      |
| POST   | `/api/port-forward/`          | Create a port forward       |
| POST   | `/api/port-forward/:id/start` | Start forwarding            |
| POST   | `/api/port-forward/:id/stop`  | Stop forwarding             |
| DELETE | `/api/port-forward/:id`       | Delete a forward            |

## CLI Commands

SSH and port forward CLI commands are built into the `vibe` CLI:

```bash
vibe ssh list                       # List saved connections
vibe ssh add --name my-server ...   # Add a connection
vibe ssh test -i <id>               # Test connectivity
vibe ssh exec -i <id> -c "uptime"   # Run remote command

vibe forward list                   # List port forwards
vibe forward create --local 5432 --remote-host db --remote-port 5432 --server my-server
vibe forward start -i <id>          # Start forwarding
vibe forward stop -i <id>           # Stop forwarding
```

## Requirements

- VibeControls Agent >= 1.1.0
- Node.js >= 18.0.0

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **OpenSSH** — <https://www.openssh.com/>

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Important: agent is not open source

The `@vibecontrols/agent` runtime that loads and orchestrates these plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. Only the plugin contract and the plugins themselves are released under MIT. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
