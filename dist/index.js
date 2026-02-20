export const vibePlugin = {
    name: "ssh",
    version: "1.0.0",
    description: "SSH connections & port forwarding for VibeControls Agent",
    async onServerStart(app) {
        // Dynamically import ssh2 — this is the whole point of the plugin:
        // ssh2 (with native cpu-features) is only loaded when the plugin is installed.
        const { sshRoutes } = await import("./routes/ssh.js");
        const { portForwardRoutes } = await import("./routes/port-forward.js");
        await app.register(sshRoutes, { prefix: "/api/ssh" });
        await app.register(portForwardRoutes, { prefix: "/api/port-forward" });
        console.log("  🔌 Plugin 'ssh' registered routes: /api/ssh, /api/port-forward");
    },
    onCliSetup(program) {
        // SSH CLI commands are registered by the agent's built-in CLI for now.
        // In a future version, the CLI commands will also move into this plugin.
        // For now, the plugin only contributes server-side routes.
    },
};
export default vibePlugin;
//# sourceMappingURL=index.js.map