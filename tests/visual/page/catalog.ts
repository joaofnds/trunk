/**
 * Mounts the design catalog alone: no host, no bindings, since it asks the
 * backend nothing. `app.css` is the app's own stylesheet, so the catalog draws
 * the tokens as the app does.
 */
import { mount } from "svelte";
import "../../../src/app.css";
import Catalog from "../../../src/lib/ui/Catalog.svelte";

mount(Catalog, { target: document.getElementById("app") as HTMLElement });
