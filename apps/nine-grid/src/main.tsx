import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, readTheme } from '../../../src/theme-state.js';
import '../../../src/theme-tokens.css';
import './styles.css';

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
