import React from "react";
import { createRoot } from "react-dom/client";
import App from "./main.jsx";

// Preserve the root if Vite reloads this entry; components refresh independently.
const root =
  import.meta.hot?.data.root || createRoot(document.getElementById("root"));
if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.root = root;
  });
root.render(<App />);
