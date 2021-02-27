import { expect } from 'chai'
import { createInBounds } from './utils'

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
