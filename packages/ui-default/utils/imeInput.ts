import { debounce } from 'lodash';

export interface ImeInputBinding {
  isComposing: () => boolean;
  cancel: () => void;
  destroy: () => void;
}

export default function bindImeInput(
  $input: JQuery<HTMLInputElement>,
  callback: () => void,
  wait: number,
): ImeInputBinding {
  let composing = false;
  const debounced = debounce(() => {
    if (!composing) callback();
  }, wait);
  const handleCompositionStart = () => {
    composing = true;
    debounced.cancel();
  };
  const handleCompositionEnd = () => {
    composing = false;
    debounced();
  };
  const handleInput = (ev: JQuery.TriggeredEvent<HTMLInputElement>) => {
    const nativeEvent = ev.originalEvent as InputEvent | undefined;
    if (composing || nativeEvent?.isComposing) {
      debounced.cancel();
      return;
    }
    debounced();
  };

  $input.on('compositionstart', handleCompositionStart);
  $input.on('compositionend', handleCompositionEnd);
  $input.on('input', handleInput);

  return {
    isComposing: () => composing,
    cancel: () => debounced.cancel(),
    destroy: () => {
      debounced.cancel();
      $input.off('compositionstart', handleCompositionStart);
      $input.off('compositionend', handleCompositionEnd);
      $input.off('input', handleInput);
    },
  };
}
