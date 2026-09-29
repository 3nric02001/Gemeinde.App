import { render } from 'preact';
import { App } from './app';
import { applyTextSize } from './display';
import './styles.css';

applyTextSize();
render(<App />, document.getElementById('app')!);
