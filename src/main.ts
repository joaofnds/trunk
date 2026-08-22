import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { startPerfSession } from "./lib/perf-session.js";
import { trackScrollActivity } from "./lib/scrollbar-activity.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app element");

trackScrollActivity();

startPerfSession().then((path) => {
	if (path) console.info(`perf samples: ${path}`);
});

const app = mount(App, { target });

export default app;
