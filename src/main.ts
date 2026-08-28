import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { startAppServices } from "./lib/app-services.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app element");

startAppServices();

const app = mount(App, { target });

export default app;
