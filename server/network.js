// Ark and Doubao live in Beijing. From a server abroad the TCP handshake can take
// over a second (the first SYN is often dropped), far past Node's 250 ms
// per-address default, so every call failed with ETIMEDOUT. Prefer IPv4 and give
// each address 10 s before moving on to the next one.

import dns from 'node:dns';
import net from 'node:net';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(10_000);
