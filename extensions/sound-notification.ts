import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAC_SOUND = "/System/Library/Sounds/Glass.aiff";

function bell(): void {
	process.stdout.write("\u0007");
}

function playDoneSound(): void {
	if (process.platform !== "darwin") {
		bell();
		return;
	}

	execFile("afplay", [process.env.PI_SOUND_NOTIFICATION_FILE || DEFAULT_MAC_SOUND], { timeout: 3_000 }, (error) => {
		if (error) bell();
	});
}

export default function soundNotification(pi: ExtensionAPI) {
	pi.on("agent_end", () => {
		playDoneSound();
	});
}
