import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "./main.jsx";
import ModuleBoundary from "./module-boundary.jsx";
import { installSharedTransitions } from "./view-transition.js";

installSharedTransitions();
// Preserve the root if Vite reloads this entry; components refresh independently.
const root =
  import.meta.hot?.data.root || createRoot(document.getElementById("root"));
if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.root = root;
  });
// Committing synchronously puts shared elements in the first rendered frame, which
// is the one the browser captures for a cross-document view transition.
flushSync(() =>
  root.render(
    <ModuleBoundary label="个人空间">
      <App />
    </ModuleBoundary>,
  ),
);
