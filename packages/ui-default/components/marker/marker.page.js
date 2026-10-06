import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import MarkerReactive from './MarkerReactive';

const markerPage = new AutoloadPage('markerPage', () => {
  MarkerReactive.initAll();
  $(document).on('vjContentNew.marker', () => MarkerReactive.initAll());
});

export default markerPage;
