import {describe, it} from 'mocha';
import {assert} from 'chai';
import {
    parseDurationComparison,
    parseGenericValueComparison,
    parseGenericValueOrPercentComparison,
    parseRedditEntity
} from "../src/util";
import dayjs from "dayjs";
import dduration from 'dayjs/plugin/duration.js';


describe('Non-temporal Comparison Operations', function () {
    it('should throw if no operator sign', function () {
        const shouldThrow = () => parseGenericValueComparison('just 3');
        assert.throws(shouldThrow)
    });
    it('should parse greater-than with a numeric value', function () {
        const res = parseGenericValueComparison('> 3');
        assert.equal(res.operator, '>')
        assert.equal(res.value, 3);
    });
    it('should parse greater-than-or-equal-to with a numeric value', function () {
        const res = parseGenericValueComparison('>= 3');
        assert.equal(res.operator, '>=')
        assert.equal(res.value, 3)
    })
    it('should parse less-than with a numeric value', function () {
        const res = parseGenericValueComparison('< 3');
        assert.equal(res.operator, '<')
        assert.equal(res.value, 3)
    })
    it('should parse less-than-or-equal-to with a numeric value', function () {
        const res = parseGenericValueComparison('<= 3');
        assert.equal(res.operator, '<=')
        assert.equal(res.value, 3)
    })
    it('should parse extra content', function () {
        const res = parseGenericValueComparison('<= 3 foobars');
        assert.equal(res.extra, ' foobars')

        const noExtra = parseGenericValueComparison('<= 3');
        assert.isUndefined(noExtra.extra)
    })
    it('should parse percentage', function () {
        const withPercent = parseGenericValueOrPercentComparison('<= 3%');
        assert.isTrue(withPercent.isPercent)

        const withoutPercent = parseGenericValueOrPercentComparison('<= 3');
        assert.isFalse(withoutPercent.isPercent)
    })
});

describe('Temporal Comparison Operations', function () {
    before('Extend DayJS', function () {
        dayjs.extend(dduration);
    });
    it('should throw if no operator sign', function () {
        assert.throws(() => parseDurationComparison('just 3'))
    });
    it('should throw if no units', function () {
        assert.throws(() => parseDurationComparison('> 3'))
    });
    it('should accept milliseconds units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 millisecond'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 milliseconds'))
    });
    it('should accept seconds units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 second'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 seconds'))
    });
    it('should accept minutes units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 minute'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 minutes'))
    });
    it('should accept hours units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 hour'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 hours'))
    });
    it('should accept days units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 day'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 days'))
    });
    it('should accept weeks units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 week'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 weeks'))
    });
    it('should accept months units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 month'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 months'))
    });
    it('should accept years units', function () {
        assert.doesNotThrow(() => parseDurationComparison('> 3 year'))
        assert.doesNotThrow(() => parseDurationComparison('> 3 years'))
    });
    it('should only accept units compatible with dayjs', function () {
        assert.throws(() => parseDurationComparison('> 3 gigawatts'))
    });
    it('should parse greater-than with a duration', function () {
        const res = parseDurationComparison('> 3 days');
        assert.equal(res.operator, '>')
        assert.isTrue(dayjs.isDuration(res.duration));
    });
    it('should parse greater-than-or-equal-to with a duration', function () {
        const res = parseDurationComparison('>= 3 days');
        assert.equal(res.operator, '>=')
        assert.isTrue(dayjs.isDuration(res.duration));
    })
    it('should parse less-than with a duration', function () {
        const res = parseDurationComparison('< 3 days');
        assert.equal(res.operator, '<')
        assert.isTrue(dayjs.isDuration(res.duration));
    })
    it('should parse less-than-or-equal-to with a duration', function () {
        const res = parseDurationComparison('<= 3 days');
        assert.equal(res.operator, '<=')
        assert.isTrue(dayjs.isDuration(res.duration));
    })
});

describe('Parsing Reddit Entity strings', function() {
    it('should recognize entity regardless of prefix', function() {
        assert.equal(parseRedditEntity('/r/mySubreddit').name, 'mySubreddit');
        assert.equal(parseRedditEntity('r/mySubreddit').name, 'mySubreddit');
    })

    it('should distinguish between subreddit and user prefixes', function() {
        assert.equal(parseRedditEntity('/r/mySubreddit').type, 'subreddit');
        assert.equal(parseRedditEntity('r/mySubreddit').type, 'subreddit');
        assert.equal(parseRedditEntity('/u/aUser').type, 'user');
        assert.equal(parseRedditEntity('u/aUser').type, 'user');
    })

    it('should recognize user based on u_ prefix', function() {
        assert.equal(parseRedditEntity(' u_aUser ').type, 'user');
    })

    it('should handle whitespace', function() {
        assert.equal(parseRedditEntity(' /r/mySubreddit ').name, 'mySubreddit');
    })

    it('should handle dashes in the name', function() {
        assert.equal(parseRedditEntity(' /u/a-user ').name, 'a-user');
    })
})
