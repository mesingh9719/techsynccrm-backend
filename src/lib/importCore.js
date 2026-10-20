// Generated from frontend/src/lib/importCore.ts by npm run import:sync. Edit the source, then regenerate.
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
export const emptyOverlay = () => ({ cells: {}, deletedRows: [], addedRows: [] });
export const overlayStats = (overlay = emptyOverlay()) => ({
    editedCells: Object.values(overlay.cells).reduce((n, row) => n + Object.keys(row).length, 0),
    removedRows: overlay.deletedRows.length,
    addedRows: overlay.addedRows.length,
});
export function applyOverlay(rows, overlay = emptyOverlay()) {
    const removed = new Set(overlay.deletedRows);
    return [...rows, ...overlay.addedRows.map((row) => ({ ...row, sourceRow: null }))]
        .filter((row) => !removed.has(row.id))
        .map((row) => {
        const changes = overlay.cells[row.id];
        if (!changes)
            return row;
        const values = [...row.values];
        for (const [column, value] of Object.entries(changes))
            values[Number(column)] = value;
        return { ...row, values };
    });
}
export function changeCells(overlay, changes) {
    const cells = { ...overlay.cells };
    for (const { rowId, column, value, original } of changes) {
        const row = { ...cells[rowId] };
        if (value === original)
            delete row[String(column)];
        else
            row[String(column)] = value;
        if (Object.keys(row).length)
            cells[rowId] = row;
        else
            delete cells[rowId];
    }
    return { ...overlay, cells };
}
export function parseIndianMoney(value) {
    let text = String(value).trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/,/g, '').trim();
    const suffix = text.match(/\s*(lakh|lakhs|l|crore|crores|cr)$/i);
    const multiplier = suffix ? (/^(l|lakh|lakhs)$/i.test(suffix[1]) ? 100_000 : 10_000_000) : 1;
    if (suffix)
        text = text.slice(0, suffix.index).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text))
        throw new Error('Enter a non-negative amount, such as ₹1,85,000 or 1.2 L.');
    const [whole, fraction = ''] = text.split('.');
    const amount = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(multiplier);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('Money amount is too large.');
    return Number(amount);
}
export function parseImportDate(value, format = 'DMY') {
    const text = String(value).trim();
    let y, m, d;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const serial = Number(text);
        if (serial < 1 || serial > 2958465 || Math.floor(serial) === 60)
            throw new Error('Invalid Excel date.');
        return new Date(Date.UTC(1899, 11, 31) + (Math.floor(serial) - (serial > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const parts = text.split('-').map(Number);
        y = parts[0];
        m = parts[1];
        d = parts[2];
    }
    else {
        const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (!match)
            throw new Error('Enter a valid calendar date.');
        const [a, b, year] = match.slice(1).map(Number);
        [y, m, d] = format === 'MDY' ? [year, a, b] : [year, b, a];
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (y < 1900 || y > 9999 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
        throw new Error('Enter a valid calendar date.');
    }
    return date.toISOString().slice(0, 10);
}
export function validateMappedRow(headers, row, mapping, context = {}) {
    const { entityType = 'lead', country = 'IN', dateFormat = 'DMY', definitions = [] } = context;
    const values = {};
    const display = {};
    const issues = [];
    headers.forEach((header, column) => {
        const field = mapping[header];
        if (!field)
            return;
        const value = String(row[column] ?? '').trim();
        values[field] = value;
        display[field] = value;
        if (!value)
            return;
        const fail = (message, severity = 'error') => issues.push({ field, column, message, severity });
        if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            fail('Enter a valid email address.');
        if (field === 'pincode' && !/^[1-9][0-9]{5}$/.test(value))
            fail('Enter a 6-digit PIN code.');
        if (field === 'phone') {
            const phone = parsePhoneNumberFromString(value, country);
            if (phone?.isValid())
                display[field] = phone.number;
            else
                fail('Phone could not be normalized; it will be kept as entered.', 'warning');
        }
        try {
            if (['budgetMinor', 'valueMinor'].includes(field))
                display[field] = parseIndianMoney(value) / 100;
            if (field === 'expectedCloseDate')
                display[field] = parseImportDate(value, dateFormat);
            if (field.startsWith('cf.')) {
                const definition = definitions.find((item) => item.key === field.slice(3));
                if (!definition)
                    return;
                if (definition.type === 'date')
                    display[field] = parseImportDate(value, dateFormat);
                if (definition.type === 'currency')
                    display[field] = parseIndianMoney(value) / 100;
                if (definition.type === 'number') {
                    if (!Number.isFinite(Number(value)))
                        throw new Error(`Enter a valid number for ${definition.label}.`);
                    display[field] = Number(value);
                }
                if (['select', 'multiselect'].includes(definition.type)) {
                    const options = definition.options ?? [];
                    const selected = definition.type === 'multiselect' ? value.split(/[;,]/).map((item) => item.trim()) : [value];
                    const canonical = selected.map((item) => options.find((option) => option.label.toLowerCase() === item.toLowerCase() || option.value.toLowerCase() === item.toLowerCase())?.value);
                    if (canonical.some((item) => item === undefined))
                        throw new Error(`Choose an existing option for ${definition.label}.`);
                    display[field] = canonical.join('; ');
                }
                if (definition.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
                    throw new Error(`Enter a valid email for ${definition.label}.`);
                if (definition.type === 'phone') {
                    const number = parsePhoneNumberFromString(value, country);
                    display[field] = number?.isValid() ? number.number : value;
                }
                if (definition.type === 'checkbox') {
                    if (!/^(yes|no|true|false|1|0)$/i.test(value))
                        throw new Error(`Use yes/no for ${definition.label}.`);
                    display[field] = /^(yes|true|1)$/i.test(value) ? 'Yes' : 'No';
                }
            }
        }
        catch (error) {
            fail(error.message);
        }
        const maxMap = { firstName: 80, lastName: 80, fullName: 161, name: 160, companyName: 160, city: 80, requirement: 2000 };
        const max = maxMap[field];
        if (max && value.length > max)
            fail(`Keep this value under ${max} characters.`);
    });
    const required = entityType === 'company' ? ['name'] : entityType === 'deal' ? ['title'] : [];
    for (const field of required) {
        if (!values[field]) {
            issues.push({
                field,
                column: headers.findIndex((header) => mapping[header] === field),
                severity: 'error',
                message: `${field === 'name' ? 'Company name' : 'Deal title'} is required.`,
            });
        }
    }
    if (['lead', 'contact'].includes(entityType) && !['fullName', 'firstName', 'phone', 'email'].some((field) => values[field])) {
        issues.push({ field: 'fullName', column: 0, severity: 'error', message: 'Enter a name, phone, or email.' });
    }
    return { values, display, issues };
}
export function identityKeys(entity, input) {
    if (entity === 'deal')
        return [];
    if (entity === 'company') {
        const domain = String(input.domain ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
        return ['name', 'domain', 'gstin'].filter((key) => key === 'domain' ? domain : input[key]).map((key) => `${key}:${key === 'domain' ? domain : String(input[key]).trim().toLowerCase()}`);
    }
    return [
        ...(input.emails ?? []).map((email) => `email:${email.value.toLowerCase()}`),
        ...(input.phones ?? []).map((phone) => {
            const parsed = parsePhoneNumberFromString(phone.e164 || phone.raw || '', input.country || 'IN');
            return parsed?.isValid() ? `phone:${parsed.number}` : null;
        }).filter(Boolean),
    ];
}
