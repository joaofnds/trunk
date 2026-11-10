/**
 * Mounts the comment affordance prototype alone, over mock lines, with the
 * app's own stylesheet so it draws the tokens as the app does.
 */
import { mount } from "svelte";
import "../../app.css";
import CommentAffordancePrototype from "./CommentAffordancePrototype.svelte";

mount(CommentAffordancePrototype, {
	target: document.getElementById("app") as HTMLElement,
});
