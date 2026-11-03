import { execFile } from "node:child_process";
import { promisify } from "node:util";
import z from "@deepseek-ai/schemastery";

//#region lib/types/index.js
/**
* Human-facing `/restart` command that restarts the dsh-web systemd unit from
* inside a live Web session.
*
* The restart itself is delegated to a transient systemd unit
* (`systemd-run --on-active=Ns`), which lives beside `dsh-web.service` in the
* hierarchy rather than inside its cgroup. A direct `systemctl restart` would
* kill this very process (dsweb runs with KillMode=control-group), so the
* deferred dispatch is what makes an in-session restart possible.
*
* @module dsh-command-restart
*/

const name = "command-restart";
const inject = ["commands"];

/** Validated plugin configuration. */
const Config = z.object({
	/** systemd unit that serves the Web UI. */
	unit: z.string().default("dsh-web"),
	/** Delay before the restart fires, so the reply reaches the browser first. */
	defaultDelaySeconds: z.number().default(3)
});

const execFileAsync = promisify(execFile);

/** Units created by this command all share this prefix, for lookup and cancel. */
const UNIT_PREFIX = "dsh-restart-";

const USAGE =
	"Usage: /restart [seconds]  restart dsh-web after a delay (default from config)\n" +
	"       /restart status     show the service state\n" +
	"       /restart cancel     cancel a pending scheduled restart";

/**
* Run one child process without a shell and return its stdout.
* @param file - executable to run.
* @param args - argument vector.
* @param timeoutMs - cooperative deadline for the child.
* @returns captured stdout and stderr.
*/
async function capture(file, args, timeoutMs) {
	const { stdout, stderr } = await execFileAsync(file, args, {
		timeout: timeoutMs,
		maxBuffer: 1 << 20,
		encoding: "utf8"
	});
	return { stdout, stderr };
}

/**
* Rewrite a process failure into one diagnostic line.
* @param error - rejection from a child process helper.
* @returns a message naming the underlying cause.
*/
function describeFailure(error) {
	const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
	if (stderr.length > 0) return stderr.split("\n").slice(-3).join(" ");
	if (typeof error?.message === "string" && error.message.length > 0) return error.message;
	return String(error);
}

/**
* Report the configured unit's current state.
* @param unit - systemd unit name without a suffix.
* @returns a human-only command result.
*/
async function readStatus(unit) {
	try {
		const { stdout } = await capture(
			"systemctl",
			["show", unit, "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ActiveEnterTimestamp"],
			10_000
		);
		const fields = new Map();
		for (const line of stdout.split("\n")) {
			const at = line.indexOf("=");
			if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
		}
		const state = fields.get("ActiveState") ?? "unknown";
		const sub = fields.get("SubState") ?? "unknown";
		const pid = fields.get("MainPID") ?? "0";
		const since = fields.get("ActiveEnterTimestamp") ?? "";
		const core = `${unit}: ${state} (${sub}), MainPID ${pid}`;
		return { kind: "success", text: since.length > 0 ? `${core}, since ${since}` : core };
	} catch (error) {
		return { kind: "error", text: `Could not read ${unit} state: ${describeFailure(error)}` };
	}
}

/**
* List pending restart units created by this command.
* @returns timer unit names, empty when none are pending.
*/
async function pendingTimers() {
	try {
		const { stdout } = await capture(
			"systemctl",
			["list-units", "--type=timer", "--all", "--no-legend", "--plain", `${UNIT_PREFIX}*`],
			10_000
		);
		return stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/u)[0] ?? "")
			.filter((entry) => entry.startsWith(`${UNIT_PREFIX}`) && entry.endsWith(".timer"));
	} catch {
		return [];
	}
}

/**
* Cancel every pending restart timer.
* @returns a human-only command result.
*/
async function cancelPending() {
	const timers = await pendingTimers();
	if (timers.length === 0) return { kind: "success", text: "No pending restart to cancel." };
	const failed = [];
	for (const timer of timers) {
		try {
			await capture("sudo", ["-n", "systemctl", "stop", timer], 20_000);
		} catch (error) {
			failed.push(`${timer}: ${describeFailure(error)}`);
		}
	}
	if (failed.length > 0) return { kind: "error", text: `Could not cancel: ${failed.join("; ")}` };
	return { kind: "success", text: `Cancelled ${timers.join(", ")}.` };
}

/**
* Schedule a deferred `systemctl restart` of the configured unit.
* @param unit - systemd unit name without a suffix.
* @param delaySeconds - whole seconds before the restart fires.
* @returns a human-only command result.
*/
async function scheduleRestart(unit, delaySeconds) {
	const transient = `${UNIT_PREFIX}${Date.now()}`;
	try {
		await capture(
			"sudo",
			[
				"-n",
				"systemd-run",
				"--quiet",
				"--collect",
				`--unit=${transient}`,
				`--on-active=${delaySeconds}s`,
				"/bin/systemctl",
				"restart",
				unit
			],
			30_000
		);
	} catch (error) {
		return { kind: "error", text: `Could not schedule the restart: ${describeFailure(error)}` };
	}
	return {
		kind: "success",
		text:
			`Restarting ${unit} in ${delaySeconds}s (scheduled by ${transient}.timer).\n` +
			"The page will lose its connection and reconnect on its own once the service is back; " +
			"this session keeps its cookie, so no new login link is needed."
	};
}

/**
* Register `/restart` for every composed human-command adapter.
* @param ctx - context carrying the command registry.
* @param config - resolved plugin configuration.
*/
function apply(ctx, config) {
	const unit = config.unit;
	const defaultDelay = config.defaultDelaySeconds;

	/** Run one `/restart` invocation. */
	const handler = async (invocation) => {
		const raw = invocation.rawInput.trim();
		if (raw === "status") return readStatus(unit);
		if (raw === "cancel") return cancelPending();
		if (raw.length > 0 && !/^\d+$/u.test(raw)) return { kind: "error", text: USAGE };
		const delay = raw.length > 0 ? Number(raw) : defaultDelay;
		if (!Number.isSafeInteger(delay) || delay < 1 || delay > 600) {
			return { kind: "error", text: `Delay must be a whole number of seconds between 1 and 600.\n${USAGE}` };
		}
		if (invocation.signal.aborted) return { kind: "error", text: "Restart cancelled." };
		return scheduleRestart(unit, delay);
	};

	ctx.effect(function* () {
		yield ctx.commands.register({
			name: "restart",
			description: "Restart the dsh-web service without ending this session",
			input: { hint: "[seconds] | status | cancel" },
			recordInput: false,
			handler
		});
	}, "command-restart lifecycle");
}
//#endregion

export { Config, apply, inject, name };
