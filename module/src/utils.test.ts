import { expect } from 'chai'
import { createInBounds, resolveContext } from './utils'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'

describe('resolveContext', () => {
  it('resolves the self alias to the self context', () => {
    expect(resolveContext('self', SELF)).to.equal(SELF)
    expect(resolveContext('vessels.self', SELF)).to.equal(SELF)
  })
  it('qualifies a bare vessel id', () => {
    expect(resolveContext('urn:mrn:imo:mmsi:987654321', SELF)).to.equal('vessels.urn:mrn:imo:mmsi:987654321')
  })
  it('leaves an already qualified context alone', () => {
    expect(resolveContext('vessels.urn:mrn:imo:mmsi:987654321', SELF)).to.equal('vessels.urn:mrn:imo:mmsi:987654321')
  })
  it('falls back to the literal id when selfContext is unavailable', () => {
    expect(resolveContext('self', undefined)).to.equal('vessels.self')
  })
})

describe('inBounds', () => {
  it('works for bounds', () => {
    const inBounds = createInBounds({ sw: [-10, -10], ne: [10, 175] })
    expect(inBounds([-11, 176])).to.be.false
    expect(inBounds([-9, 174])).to.be.true
    expect(inBounds([-9, 176])).to.be.false
    expect(inBounds([+9, -11])).to.be.false
    expect(inBounds([+9, -10])).to.be.true
  })
  it('works for bounds crossing dateline', () => {
    const inBounds = createInBounds({ sw: [-10, 175], ne: [10, -175] })
    expect(inBounds([-11, 176])).to.be.false
    expect(inBounds([-9, 176])).to.be.true
    expect(inBounds([-9, -176])).to.be.true
    expect(inBounds([-9, -174])).to.be.false
    expect(inBounds([+9, -174])).to.be.false
    expect(inBounds([+9, -176])).to.be.true
    expect(inBounds([+11, -176])).to.be.false
  })
})
