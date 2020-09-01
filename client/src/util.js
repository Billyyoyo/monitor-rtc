export function uuidv4() {
    let uuid = ('111-111-1111').replace(/[018]/g, () =>
        (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16))
    return uuid.replace(/-/g, '')
}

export async function sleep(ms) {
    return new Promise((r) => setTimeout(() => r(), ms));
}