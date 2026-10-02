import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import { render } from 'preact';
import { App } from './Shell.tsx';
import { start } from './store.ts';
import './styles.css';

start();
render(<App />, document.getElementById('app')!);
