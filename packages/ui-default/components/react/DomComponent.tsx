import { omit } from 'lodash';
import React from 'react';

export default function DomComponent(props: React.HTMLAttributes<HTMLDivElement> & { childDom: HTMLElement }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const host = ref.current;
    const child = props.childDom;
    const parent = child.parentNode;
    const next = child.nextSibling;
    host.appendChild(child);
    return () => {
      // React may unmount this host during error recovery. Return the borrowed
      // node before its host disappears, unless the caller already moved it.
      if (child.parentNode === host) {
        if (parent) parent.insertBefore(child, next?.parentNode === parent ? next : null);
        else child.remove();
      }
    };
  }, [props.childDom]);
  return <div {...omit(props, 'childDom')} ref={ref}></div>;
}
