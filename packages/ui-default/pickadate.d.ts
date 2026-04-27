declare module 'pickadate/lib/picker' {
    interface PickerInstance {
        $node: any;
        $root: any;
        _hidden: HTMLInputElement;
        on(event: string, callback: (...args: any[]) => void, priority?: number): PickerInstance;
        off(event: string): PickerInstance;
        trigger(event: string, data?: any): PickerInstance;
        start(): PickerInstance;
        stop(): PickerInstance;
        open(withoutFocus?: boolean): PickerInstance;
        close(withFocus?: boolean): PickerInstance;
        get(thing: string): any;
        set(thing: string, value?: any, options?: any): PickerInstance;
        clear(): PickerInstance;
        render(entirePicker?: boolean): PickerInstance;
    }

    interface PickerStatic {
        new (element: any, type: string, component: any, options?: any): PickerInstance;
        _: PickerUtils;
        klasses(prefix?: string): PickerKlasses;
        define(name: string, component: any): void;
        extend(name: string, component: any): any;
    }

    interface PickerUtils {
        trigger(callback: any, scope: any, args?: any[]): any;
        node(type: string, content: any, klass?: string, attributes?: string): string;
        group(groupObject: any): string;
        digits(string: string): string;
        lead(number: number): string;
        isDate(value: any): boolean;
        isInteger(value: any): boolean;
        ariaAttr(attributes: Record<string, any>, options?: any): string;
    }

    interface PickerKlasses {
        picker: string;
        opened: string;
        focused: string;
        input: string;
        active: string;
        holder: string;
        frame: string;
        wrap: string;
        box: string;
        [key: string]: string;
    }

    const Picker: PickerStatic;
    export default Picker;
}
