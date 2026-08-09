import { render } from 'preact';
import { ListApp } from '../../components/ListApp';
import '../../components/app.css';

const root = document.getElementById('root');
if (root) render(<ListApp ctx="side" />, root);
