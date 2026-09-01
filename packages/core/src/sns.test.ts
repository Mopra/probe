import { createSign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSnsCertCache,
  isValidSigningCertUrl,
  parseSesMessage,
  snsCanonicalString,
  verifySnsSignature,
} from './sns';
import type { SnsEnvelope } from './sns';

// Throwaway self-signed pair, generated for this test only and used nowhere
// else. CN is an SNS host so the URL check and the crypto can both be exercised.
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCx6BJdFW6DRgXj
ZWwP728lhKQh9oI/3wzAgoMNV7AAmsxC/JDzjnonmHn5ncMlB1E+nyIhzOPzpKIV
p5q3FZs8FWq4wxlxhumWHS8WWJcmBFxlUMc1eVSSHheKxqfNZF0/SQy3O9HfIezG
YzFd36qpP843KED3b1225JCBJTrc3jm7vIV0kPC8VQsE1TsABV/dn9nzaCJSQ9aL
m+ifLgK7OX9e2Y598/IQJUHBE355kvp5t0y2DGsWVBoNNR2HOfTRVQb1XmWlGGmY
bVW614cHzp2ZNtzaOdcJyVWvyp5dAhe1eT0GvjYNsfI0bqv87pZfT2n0xSa7Gpwq
tnMZPKbBAgMBAAECggEAIwnlf/7GFsW2SCyEBXlvRxDiMKw3x/Oas9mgjQKtr9jN
DQ5oUAfKKD1AHLkFI6hWyIIX+1c6uBQ/NgueDZwMSF+hdsU6ICFlpQKXcQu+rSaj
ufKYYYBFd0fE9Die+PVg5iNxhS8bbRpl40bLBMWV+6KM71EWxoThDLHkggL+nlwz
NK0+0s/zpsDiou49PcT2YOrhMR8GN3cmIS9v8mTiPPdRo3doph7pxe6hf0JJUkyz
t7oLUSeHIkSPtwLv88+AADR8Sdla0zZGzFvWkvUw0D2seB2wggrJae+mOmFCsW5a
qrG9AVXhR61Shuxo68nUt1GFa9BcjUNjv034xnTbBwKBgQD4RFpVCXzPVBwNumJr
XvvPeXuFz+emCiDn3SplNlT3N0n9AHG3LphsN6O0OLGIXkCq7QnHY3hQddbtWeK6
UrbGWCuRr5Bno+tjuPP9vtKRy7YzFwrwMOH+0jNVV7slA71dL3u9ZWxrJqQz9Ch7
NG/MJ7U3R4JH1k+dTC4NVL/oIwKBgQC3cqyQgpXw5oBXpUm+FhIFIhTgUkPMY6Nf
K4WIVOOLTh3O7hkPdTVYeEvGoqgFd0xwkE1Y/ay4tBITDe2Ge9/CAAyj54OBGiyE
WRmMr5iNjo2ZAxsGH361hieijRXZWT9pS2yKvs3eRM3lMvUQo6E9kMJBuUZQf0RL
8CkOgHnRywKBgG1qGnGNy97Hz9FRCl0NsGagwIqZtRrdLeFh/HQ8vLdzO31wO62i
sHRJFTGxJrTV7SQncX7ZXMYBGSbjzWOWXo0NgK4lNLwoZu49LfLvrXep0vOzPRPc
R015sDv1fTnz6vntmlg/IcgbcJShD1I1KuxLt7bUIhus3MuTLlybtDQHAoGBAJ13
WrcE0K4jPaF+KOl4ymkLkz3mf3nvQSoNEqcurs9B84ZPjMVfB7Z0NB9COdXPTJcG
1s3/mgZF04n1l6Crris5naAHtzLXg8TrMmo3xEwmRFdGeijsWfh5OoZmco3J9Qtu
CbKjC9Wx28bU0dVBj8NoAccmwTuRss84TBW9pFO3AoGBALDdJ8EtkFLBfz4Uuc6u
Ku+L3223i1mw/WM6UzVp963qaFglrW2blf9UBvN67GxOzSzPD3gcqpwZCKqC8tJM
uwIXnhg75if2ZWsRLuSoTlJceOeS49k/wK904jEZpcx/HyL0b6jwq8Ie0SLHjwpW
OwzpHJW7kq/Z1nulu4CHN/iU
-----END PRIVATE KEY-----
`;

const CERT = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUAsQyCz/Bu0kXp+qjztmB7vY0nuowDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbc25zLmV1LXdlc3QtMS5hbWF6b25hd3MuY29tMB4XDTI2
MDkwMTEwMzk1MFoXDTM2MDgyOTEwMzk1MFowJjEkMCIGA1UEAwwbc25zLmV1LXdl
c3QtMS5hbWF6b25hd3MuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAsegSXRVug0YF42VsD+9vJYSkIfaCP98MwIKDDVewAJrMQvyQ8456J5h5+Z3D
JQdRPp8iIczj86SiFaeatxWbPBVquMMZcYbplh0vFliXJgRcZVDHNXlUkh4Xisan
zWRdP0kMtzvR3yHsxmMxXd+qqT/ONyhA929dtuSQgSU63N45u7yFdJDwvFULBNU7
AAVf3Z/Z82giUkPWi5vony4Cuzl/XtmOffPyECVBwRN+eZL6ebdMtgxrFlQaDTUd
hzn00VUG9V5lpRhpmG1VuteHB86dmTbc2jnXCclVr8qeXQIXtXk9Br42DbHyNG6r
/O6WX09p9MUmuxqcKrZzGTymwQIDAQABo1MwUTAdBgNVHQ4EFgQUvJL4hRR34D03
vfChdxA+7ktWQwYwHwYDVR0jBBgwFoAUvJL4hRR34D03vfChdxA+7ktWQwYwDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEADMrDwjMdufvoqcof0xLK
wiCeDodZ7gVhku4+fNwVETh6lsQo8Z8kGyBqG/9NsljJG/EazHDTrCN+ZwSno0UF
a7rQAc8hylEYpaB+iDHTqn8lh6tiVXxjUQSWE17N1HaUdugIm7CK5GVn1cjyOPc3
EzHSy5ar06TNZkhwagCYSz0znxPYhHOgXChdmKF++OIEZ4Jo309VDE9DCpz70Iqq
vvVdVphhKuEKvToV5b9jfM+qxQ2IFKJRskApo7P02OxlFo9YG5xzVDiSMcbv4K06
ShOu40ODnZPIURtsVyozen3qwE++aYvlwMPzgntWAsejKZjdLuyNtWPbHHO0r2ug
og==
-----END CERTIFICATE-----
`;

const CERT_URL =
  'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem';

function certFetch(counter?: { calls: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (counter) counter.calls += 1;
    expect(String(input)).toBe(CERT_URL);
    return new Response(CERT, { status: 200 });
  }) as unknown as typeof fetch;
}

const exploding: typeof fetch = (async () => {
  throw new Error('fetch must not be called for a rejected cert url');
}) as unknown as typeof fetch;

function sign(canonical: string, algorithm: 'RSA-SHA1' | 'RSA-SHA256'): string {
  const signer = createSign(algorithm);
  signer.update(canonical, 'utf8');
  signer.end();
  return signer.sign(PRIVATE_KEY, 'base64');
}

function notification(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const env: SnsEnvelope = {
    Type: 'Notification',
    MessageId: '22b280b9-fb08-5f3e-a0a2-1e1c7fb1f0e0',
    TopicArn: 'arn:aws:sns:eu-west-1:123456789012:probe-ses',
    Message: '{"notificationType":"Delivery"}',
    Timestamp: '2026-09-01T06:00:00.000Z',
    SignatureVersion: '1',
    Signature: '',
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  const canonical = snsCanonicalString(env);
  env.Signature = sign(canonical as string, env.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  return env;
}

beforeEach(() => {
  clearSnsCertCache();
});

describe('snsCanonicalString', () => {
  it('builds the notification string in AWS field order, omitting an absent Subject', () => {
    const env: SnsEnvelope = {
      Type: 'Notification',
      MessageId: 'mid-1',
      TopicArn: 'arn:topic',
      Message: 'hello',
      Timestamp: '2026-09-01T06:00:00.000Z',
      SignatureVersion: '1',
      Signature: 'x',
      SigningCertURL: CERT_URL,
    };
    expect(snsCanonicalString(env)).toBe(
      'Message\nhello\n' +
        'MessageId\nmid-1\n' +
        'Timestamp\n2026-09-01T06:00:00.000Z\n' +
        'TopicArn\narn:topic\n' +
        'Type\nNotification\n',
    );
  });

  it('includes Subject in alphabetical position when present', () => {
    const env: SnsEnvelope = {
      Type: 'Notification',
      MessageId: 'mid-1',
      TopicArn: 'arn:topic',
      Subject: 'a subject',
      Message: 'hello',
      Timestamp: '2026-09-01T06:00:00.000Z',
      SignatureVersion: '1',
      Signature: 'x',
      SigningCertURL: CERT_URL,
    };
    expect(snsCanonicalString(env)).toBe(
      'Message\nhello\n' +
        'MessageId\nmid-1\n' +
        'Subject\na subject\n' +
        'Timestamp\n2026-09-01T06:00:00.000Z\n' +
        'TopicArn\narn:topic\n' +
        'Type\nNotification\n',
    );
  });

  it('uses the confirmation field set for SubscriptionConfirmation', () => {
    const env: SnsEnvelope = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'mid-2',
      TopicArn: 'arn:topic',
      Message: 'confirm me',
      Timestamp: '2026-09-01T06:00:00.000Z',
      SignatureVersion: '1',
      Signature: 'x',
      SigningCertURL: CERT_URL,
      SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok',
    };
    expect(snsCanonicalString(env)).toBe(
      'Message\nconfirm me\n' +
        'MessageId\nmid-2\n' +
        'SubscribeURL\nhttps://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription\n' +
        'Timestamp\n2026-09-01T06:00:00.000Z\n' +
        'Token\ntok\n' +
        'TopicArn\narn:topic\n' +
        'Type\nSubscriptionConfirmation\n',
    );
  });

  it('returns null for an unknown envelope type', () => {
    expect(snsCanonicalString({ ...notification(), Type: 'SomethingElse' })).toBeNull();
  });
});

describe('isValidSigningCertUrl', () => {
  it('accepts AWS SNS hosts over https with a .pem path', () => {
    expect(isValidSigningCertUrl(CERT_URL)).toBe(true);
    expect(
      isValidSigningCertUrl('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-a.pem'),
    ).toBe(true);
    expect(
      isValidSigningCertUrl('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotification-a.pem'),
    ).toBe(true);
  });

  it('rejects everything else, because this check is the whole security of the webhook', () => {
    const rejected = [
      'http://sns.eu-west-1.amazonaws.com/a.pem',
      'https://evil.com/a.pem',
      'https://sns.eu-west-1.amazonaws.com.evil.com/a.pem',
      'https://evil.com/sns.eu-west-1.amazonaws.com/a.pem',
      'https://sns.eu-west-1.amazonaws.co/a.pem',
      'https://snsxeu-west-1.amazonaws.com/a.pem',
      'https://sns.eu-west-1.amazonaws.com:8443/a.pem',
      'https://sns.eu-west-1.amazonaws.com/a.txt',
      'https://user@evil.com@sns.eu-west-1.amazonaws.com/a.pem',
      'not a url',
      '',
    ];
    for (const url of rejected) {
      expect(isValidSigningCertUrl(url), url).toBe(false);
    }
  });
});

describe('verifySnsSignature', () => {
  it('accepts a valid v1 (SHA1) signature', async () => {
    await expect(verifySnsSignature(notification(), certFetch())).resolves.toBe(true);
  });

  it('accepts a valid v2 (SHA256) signature', async () => {
    await expect(
      verifySnsSignature(notification({ SignatureVersion: '2' }), certFetch()),
    ).resolves.toBe(true);
  });

  it('accepts a signed SubscriptionConfirmation', async () => {
    const env = notification({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
      Token: 'tok',
    });
    await expect(verifySnsSignature(env, certFetch())).resolves.toBe(true);
  });

  it('rejects a tampered Message', async () => {
    const env = notification();
    env.Message = '{"notificationType":"Complaint"}';
    await expect(verifySnsSignature(env, certFetch())).resolves.toBe(false);
  });

  it('rejects a tampered TopicArn and a tampered Timestamp', async () => {
    const arn = notification();
    arn.TopicArn = 'arn:aws:sns:eu-west-1:999999999999:attacker';
    await expect(verifySnsSignature(arn, certFetch())).resolves.toBe(false);

    const ts = notification();
    ts.Timestamp = '2026-09-02T06:00:00.000Z';
    await expect(verifySnsSignature(ts, certFetch())).resolves.toBe(false);
  });

  it('rejects an unknown SignatureVersion without guessing an algorithm', async () => {
    const env = notification();
    env.SignatureVersion = '3';
    await expect(verifySnsSignature(env, exploding)).resolves.toBe(false);
  });

  it('never fetches a cert from a host that is not SNS', async () => {
    const env = notification();
    env.SigningCertURL = 'https://evil.com/SimpleNotificationService-a.pem';
    await expect(verifySnsSignature(env, exploding)).resolves.toBe(false);
  });

  it('returns false rather than throwing when the cert cannot be fetched', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(verifySnsSignature(notification(), failing)).resolves.toBe(false);
  });

  it('caches the certificate by url', async () => {
    const counter = { calls: 0 };
    const fetchImpl = certFetch(counter);
    await verifySnsSignature(notification(), fetchImpl);
    await verifySnsSignature(notification({ MessageId: 'another' }), fetchImpl);
    expect(counter.calls).toBe(1);
  });
});

describe('parseSesMessage', () => {
  it('suppresses a permanent bounce and names the recipients', () => {
    const event = parseSesMessage(
      JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'priya@meterbase.dev' }],
          timestamp: '2026-09-01T09:00:00.000Z',
        },
        mail: { messageId: 'ses-1', destination: ['priya@meterbase.dev'] },
      }),
    );
    expect(event.kind).toBe('bounce');
    expect(event.suppress).toBe(true);
    expect(event.reason).toBe('bounced');
    expect(event.messageId).toBe('ses-1');
    expect(event.recipients).toEqual(['priya@meterbase.dev']);
    expect(event.detail.bounceType).toBe('Permanent');
  });

  it('does not suppress a transient bounce', () => {
    const event = parseSesMessage(
      JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          bouncedRecipients: [{ emailAddress: 'priya@meterbase.dev' }],
        },
        mail: { messageId: 'ses-2', destination: ['priya@meterbase.dev'] },
      }),
    );
    expect(event.kind).toBe('bounce');
    expect(event.suppress).toBe(false);
    expect(event.reason).toBeNull();
  });

  it('suppresses every complaint', () => {
    const event = parseSesMessage(
      JSON.stringify({
        notificationType: 'Complaint',
        complaint: {
          complainedRecipients: [{ emailAddress: 'priya@meterbase.dev' }],
          complaintFeedbackType: 'abuse',
        },
        mail: { messageId: 'ses-3', destination: ['priya@meterbase.dev'] },
      }),
    );
    expect(event.kind).toBe('complaint');
    expect(event.suppress).toBe(true);
    expect(event.reason).toBe('complained');
    expect(event.recipients).toEqual(['priya@meterbase.dev']);
  });

  it('reads a delivery notification', () => {
    const event = parseSesMessage(
      JSON.stringify({
        notificationType: 'Delivery',
        delivery: { timestamp: '2026-09-01T09:00:01.000Z', smtpResponse: '250 Ok', processingTimeMillis: 812 },
        mail: { messageId: 'ses-4', destination: ['priya@meterbase.dev'] },
      }),
    );
    expect(event.kind).toBe('delivery');
    expect(event.suppress).toBe(false);
    expect(event.messageId).toBe('ses-4');
    expect(event.recipients).toEqual(['priya@meterbase.dev']);
  });

  it('understands the event publishing shape as well as the notification shape', () => {
    const cases: Array<[string, string]> = [
      ['Send', 'send'],
      ['Reject', 'reject'],
      ['Delivery', 'delivery'],
      ['Open', 'open'],
      ['Click', 'click'],
    ];
    for (const [eventType, kind] of cases) {
      const event = parseSesMessage(
        JSON.stringify({
          eventType,
          mail: { messageId: `ses-${eventType}`, destination: ['priya@meterbase.dev'] },
        }),
      );
      expect(event.kind, eventType).toBe(kind);
      expect(event.suppress).toBe(false);
    }
  });

  it('suppresses a permanent bounce delivered in the event publishing shape', () => {
    const event = parseSesMessage(
      JSON.stringify({
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
        mail: { messageId: 'ses-5', destination: ['a@b.com'] },
      }),
    );
    expect(event.kind).toBe('bounce');
    expect(event.suppress).toBe(true);
  });

  it('maps an inbound receipt to kind inbound', () => {
    const event = parseSesMessage(
      JSON.stringify({
        notificationType: 'Received',
        receipt: {
          recipients: ['morten@mail.exit1.dev'],
          spamVerdict: { status: 'PASS' },
          virusVerdict: { status: 'PASS' },
          action: { type: 'S3', bucketName: 'probe-inbound', objectKey: 'raw/abc' },
        },
        mail: { messageId: 'ses-6', destination: ['morten@mail.exit1.dev'] },
      }),
    );
    expect(event.kind).toBe('inbound');
    expect(event.suppress).toBe(false);
    expect(event.reason).toBeNull();
    expect(event.recipients).toEqual(['morten@mail.exit1.dev']);
    expect(event.detail.objectKey).toBe('raw/abc');
  });

  it('returns unknown rather than throwing for anything unrecognised', () => {
    for (const message of ['', 'not json', '[]', 'null', '{"hello":"world"}', '{"eventType":"Nope"}']) {
      const event = parseSesMessage(message);
      expect(event.kind, message).toBe('unknown');
      expect(event.suppress).toBe(false);
      expect(event.reason).toBeNull();
    }
  });
});
