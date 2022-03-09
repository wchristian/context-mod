import {describe, it} from 'mocha';
import {assert} from 'chai';
import {
    parseDuration,
    parseDurationComparison,
    parseGenericValueComparison,
    parseGenericValueOrPercentComparison,
    parseRedditEntity, removeUndefinedKeys
} from "../src/util";
import dayjs from "dayjs";
import dduration, {DurationUnitType} from 'dayjs/plugin/duration.js';


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

describe('Parsing Temporal Values', function () {
    before('Extend DayJS', function () {
        dayjs.extend(dduration);
    });

    describe('Temporal Comparison Operations', function () {
        it('should throw if no operator sign', function () {
            assert.throws(() => parseDurationComparison('just 3'))
        });
        it('should throw if no units', function () {
            assert.throws(() => parseDurationComparison('> 3'))
        });

        for (const unit of ['millisecond', 'milliseconds', 'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']) {
            it(`should accept ${unit} unit`, function () {
                assert.doesNotThrow(() => parseDurationComparison(`> 3 ${unit}`))
            });
        }
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
    })

    describe('Parsing Text', function () {
        for (const unit of ['millisecond', 'milliseconds', 'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']) {
            it(`should accept ${unit} unit for duration`, function () {
                assert.equal(parseDuration(`1 ${unit}`).asMilliseconds(), dayjs.duration(1, unit as DurationUnitType).asMilliseconds());
            });
        }
        it('should accept ISO8601 durations', function () {

            assert.equal(parseDuration('P23DT23H').asSeconds(), dayjs.duration({
                days: 23,
                hours: 23
            }).asSeconds());

            assert.equal(parseDuration('P3Y6M4DT12H30M5S').asSeconds(), dayjs.duration({
                years: 3,
                months: 6,
                days: 4,
                hours: 12,
                minutes: 30,
                seconds: 5
            }).asSeconds());
        });
    })

});

describe('Parsing Reddit Entity strings', function () {
    it('should recognize entity regardless of prefix', function () {
        assert.equal(parseRedditEntity('/r/mySubreddit').name, 'mySubreddit');
        assert.equal(parseRedditEntity('r/mySubreddit').name, 'mySubreddit');
    })

    it('should distinguish between subreddit and user prefixes', function () {
        assert.equal(parseRedditEntity('/r/mySubreddit').type, 'subreddit');
        assert.equal(parseRedditEntity('r/mySubreddit').type, 'subreddit');
        assert.equal(parseRedditEntity('/u/aUser').type, 'user');
        assert.equal(parseRedditEntity('u/aUser').type, 'user');
    })

    it('should recognize user based on u_ prefix', function () {
        assert.equal(parseRedditEntity(' u_aUser ').type, 'user');
    })

    it('should handle whitespace', function () {
        assert.equal(parseRedditEntity(' /r/mySubreddit ').name, 'mySubreddit');
    })

    it('should handle dashes in the name', function () {
        assert.equal(parseRedditEntity(' /u/a-user ').name, 'a-user');
    })
})

describe('Config Parsing', function () {
    describe('Deep pruning of undefined keys on config objects', function () {
        it('removes undefined keys from objects', function () {
            const obj = {
                keyA: 'foo',
                keyB: 'bar',
                keyC: undefined
            };
            assert.deepEqual({keyA: 'foo', keyB: 'bar'}, removeUndefinedKeys(obj))
        })
        it('returns undefined if object has no keys after removing undefined keys', function () {
            const obj = {
                keyA: undefined,
                keyB: undefined,
                keyC: undefined
            };
            assert.isUndefined(removeUndefinedKeys(obj))
        })
        it('ignores arrays', function () {
            const obj = {
                keyA: undefined,
                keyB: 'bar',
                keyC: ['foo', 'bar']
            };
            assert.deepEqual({keyB: 'bar', keyC: ['foo', 'bar']}, removeUndefinedKeys(obj))
        })
    })
})
