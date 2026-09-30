import { render } from 'preact';
import { App } from './app';
import { applyTextSize } from './display';
import { registerServiceWorker } from './offline';
import './fonts.css';
import './styles.css';

applyTextSize();
registerServiceWorker();
render(<App />, document.getElementById('app')!);
