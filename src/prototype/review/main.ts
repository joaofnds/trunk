/**
 * Mounts the review prototype alone: no host and no bindings, since it draws
 * mock data. `app.css` is the app's own stylesheet, so it draws the tokens as
 * the app does.
 */
import { mount } from "svelte";
import "../../app.css";
import ReviewPrototype from "./ReviewPrototype.svelte";

mount(ReviewPrototype, {
	target: document.getElementById("app") as HTMLElement,
});
