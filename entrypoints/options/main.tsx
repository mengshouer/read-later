import { render } from 'preact';
import { OptionsApp } from '../../components/OptionsApp';
import '../../components/app.css';

const root = document.getElementById('root');
if (root) render(<OptionsApp />, root);
