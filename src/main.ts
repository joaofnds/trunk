import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { trackScrollActivity } from "./lib/scrollbar-activity.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app element");

trackScrollActivity();

const app = mount(App, { target });

export default app;
