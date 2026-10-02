def average(xs):
    """Mean of a list of numbers; 0.0 for an empty list."""
    if xs == []:
        return 0
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2]
